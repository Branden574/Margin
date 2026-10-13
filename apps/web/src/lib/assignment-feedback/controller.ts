import { FeedbackClient, type FeedbackDraft, type PendingFeedback } from './client';
import {
  content,
  same,
  type FeedbackCapture,
  type FeedbackContent,
  type TeacherFeedback,
} from './decode';

export interface FeedbackState {
  server: TeacherFeedback | null;
  content: FeedbackContent;
  busy: boolean;
  localSaving: boolean;
  pending: boolean;
  dirty: boolean;
  conflict: boolean;
  invalidated: boolean;
  error: string;
}
const message = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : 'Feedback could not be saved. Its existing draft is preserved.';
/** One controller owns a single author + captured submission. No local role setting grants access. */
export class FeedbackController {
  private state: FeedbackState = {
    server: null,
    content: { comment: '', annotations: [] },
    busy: true,
    localSaving: false,
    pending: false,
    dirty: false,
    conflict: false,
    invalidated: false,
    error: '',
  };
  private draft: FeedbackDraft | null = null;
  private readonly listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private performing = false;
  private generation = 0;
  private readonly removeInvalidation: () => void;
  constructor(
    private readonly client: FeedbackClient,
    private readonly snapshot: FeedbackCapture,
  ) {
    this.removeInvalidation = client.subscribeInvalidation(() => {
      this.closed = true;
      this.generation++;
      this.draft = null;
      this.state = {
        ...this.state,
        server: null,
        content: { comment: '', annotations: [] },
        busy: false,
        localSaving: false,
        pending: false,
        invalidated: true,
        error: 'Feedback access ended. Reopen this assignment from Canvas.',
      };
      this.emit();
    });
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private patch(value: Partial<FeedbackState>) {
    if (!this.closed) {
      this.state = { ...this.state, ...value };
      this.emit();
    }
  }
  private check() {
    if (this.closed) throw new Error('Feedback access ended. Reopen this submission.');
    this.client.check();
  }
  private async load() {
    const server = await this.client.teacher();
    this.check();
    if (!same(server.capture, this.snapshot))
      throw new Error('The captured submission changed. Reopen it before leaving feedback.');
    return server;
  }
  private display(server = this.state.server) {
    if (!server || !this.draft) return;
    this.patch({
      server,
      content: structuredClone(this.draft.content),
      pending: !!this.draft.pending,
      dirty: !same(this.draft.content, server.content),
      conflict: this.draft.baseRevision !== server.revision,
    });
  }
  async open() {
    try {
      const server = await this.load(),
        draft = await this.client.readDraft(this.snapshot);
      this.check();
      this.draft =
        draft ??
        (await this.client.writeDraft(
          this.snapshot,
          { content: server.content, baseRevision: server.revision, pending: null },
          null,
        ));
      this.check();
      this.display(server);
      if (this.draft.pending)
        this.patch({
          error: 'A feedback request is awaiting confirmation. Check its outcome before editing.',
        });
    } catch (reason) {
      this.patch({ error: message(reason) });
    } finally {
      this.patch({ busy: false });
    }
  }
  edit(value: FeedbackContent) {
    this.check();
    if (!this.draft || this.performing || this.draft.pending || this.state.conflict) return;
    let parsed: FeedbackContent;
    try {
      parsed = content(value, this.snapshot);
    } catch (reason) {
      this.patch({ error: message(reason) });
      return;
    }
    const generation = ++this.generation;
    this.patch({
      content: parsed,
      dirty: !same(parsed, this.state.server?.content),
      localSaving: true,
      error: '',
    });
    const write = this.tail.then(async () => {
      this.check();
      this.draft = await this.client.writeDraft(
        this.snapshot,
        { content: parsed, baseRevision: this.draft!.baseRevision, pending: null },
        this.draft,
      );
      this.check();
      if (generation === this.generation) this.patch({ localSaving: false });
    });
    this.tail = write.catch((reason) => {
      this.patch({ localSaving: false, conflict: true, error: message(reason) });
    });
  }
  private async act(action: () => Promise<void>) {
    if (this.performing || this.closed) return;
    this.performing = true;
    this.patch({ busy: true, error: '' });
    try {
      await this.tail;
      this.check();
      await action();
    } catch (reason) {
      this.patch({ error: message(reason) });
    } finally {
      this.performing = false;
      this.patch({ busy: false });
    }
  }
  private async resolve(pending: PendingFeedback, lookup: boolean) {
    const outcome = await this.client.command(pending, lookup);
    this.check();
    const baseRevision = outcome.state === 'accepted' ? outcome.revision : this.draft!.baseRevision;
    this.draft = await this.client.writeDraft(
      this.snapshot,
      { content: this.draft!.content, baseRevision, pending: null },
      this.draft,
      outcome,
    );
    this.check();
    this.patch({ pending: false });
    const server = await this.load();
    this.display(server);
    if (outcome.state === 'rejected')
      this.patch({
        conflict: true,
        error:
          outcome.code === 'revision_changed'
            ? 'Another saved revision is available. Your draft is kept. Review the saved feedback before replacing it.'
            : 'Save a feedback draft before returning it.',
      });
  }
  save = () =>
    this.act(async () => {
      if (!this.draft || this.draft.pending || this.state.conflict)
        throw new Error('Resolve the current feedback draft first.');
      const server = await this.load();
      this.display(server);
      if (server.revision !== this.draft.baseRevision)
        throw new Error('Another teacher session saved feedback. Your local draft is kept.');
      const pending: PendingFeedback = {
        action: 'save',
        input: {
          requestId: crypto.randomUUID(),
          snapshotPin: this.snapshot.snapshotPin,
          expectedRevision: this.draft.baseRevision,
          content: structuredClone(this.draft.content),
        },
      };
      this.draft = await this.client.writeDraft(
        this.snapshot,
        { ...this.draft, pending },
        this.draft,
      );
      this.display();
      await this.resolve(pending, false);
    });
  release = () =>
    this.act(async () => {
      if (!this.draft || this.draft.pending || this.state.conflict)
        throw new Error('Resolve the current feedback draft first.');
      const server = await this.load();
      this.display(server);
      if (
        !server.revision ||
        server.revision !== this.draft.baseRevision ||
        !same(server.content, this.draft.content)
      )
        throw new Error('Save this feedback before returning it to the student.');
      const pending: PendingFeedback = {
        action: 'release',
        input: {
          requestId: crypto.randomUUID(),
          snapshotPin: this.snapshot.snapshotPin,
          expectedRevision: this.draft.baseRevision,
        },
      };
      this.draft = await this.client.writeDraft(
        this.snapshot,
        { ...this.draft, pending },
        this.draft,
      );
      this.display();
      await this.resolve(pending, false);
    });
  recover = () =>
    this.act(async () => {
      const pending = this.draft?.pending;
      if (!pending) {
        this.display(await this.load());
        return;
      }
      try {
        await this.resolve(pending, true);
      } catch (reason) {
        if (
          (reason as { status?: number })?.status !== 404 ||
          (reason as { code?: string })?.code !== 'feedback_command_not_found'
        )
          throw reason;
        // A confirmed absent command permits only this exact persisted request to be sent again.
        await this.resolve(pending, false);
      }
    });
  useSaved = () =>
    this.act(async () => {
      if (!this.draft || this.draft.pending) throw new Error('Confirm the pending request first.');
      const server = await this.load();
      this.draft = await this.client.writeDraft(
        this.snapshot,
        { content: server.content, baseRevision: server.revision, pending: null },
        this.draft,
      );
      this.display(server);
      this.patch({ conflict: false });
    });
  flush = async () => {
    await this.tail;
    this.check();
    if (
      this.state.localSaving ||
      (this.state.conflict && !same(this.state.content, this.draft?.content))
    )
      throw new Error('Feedback has unsaved local changes.');
  };
  dispose() {
    this.removeInvalidation();
    this.closed = true;
    this.generation++;
    this.client.dispose();
    this.draft = null;
    this.state = { ...this.state, server: null, content: { comment: '', annotations: [] } };
    this.listeners.clear();
  }
}
