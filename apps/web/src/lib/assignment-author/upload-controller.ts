import { createVaultGuard } from '../vault';
import { readAuthorContext } from './client';
import type { AssignmentAuthorClient, AuthorContext } from './types';
import {
  prepareAuthorUpload,
  readAuthorUpload,
  readAuthorUploadFile,
  saveAuthorUploadStatus,
  type AuthorUploadTask,
} from './upload-vault';

export interface AuthorUploadState {
  task?: AuthorUploadTask;
  busy: boolean;
  stage: 'idle' | 'saving' | 'reserving' | 'checking' | 'sending';
  error: string;
  paused: boolean;
}
/** A single recoverable upload; cancellation stops transport but never deletes its recovery record. */
export class AuthorUploadController {
  private state: AuthorUploadState = { busy: false, stage: 'idle', error: '', paused: false };
  private operation: AbortController | null = null;
  private closed = false;
  private readonly vaultGuard: () => void;
  constructor(
    private readonly context: AuthorContext,
    private readonly client: AssignmentAuthorClient,
    private readonly changed: (state: AuthorUploadState) => void,
    private readonly ready: () => Promise<void>,
    private readonly invalidated: () => void = () => {},
  ) {
    readAuthorContext(context);
    this.vaultGuard = createVaultGuard();
  }
  private guard() {
    if (this.closed) throw new Error('The upload view is closed.');
    this.vaultGuard();
    readAuthorContext(this.context);
  }
  private emit(change: Partial<AuthorUploadState>) {
    this.guard();
    this.state = { ...this.state, ...change };
    this.changed(structuredClone(this.state));
  }
  dispose() {
    this.closed = true;
    this.operation?.abort();
    this.state = { busy: false, stage: 'idle', error: '', paused: false };
  }
  private invalidate() {
    if (!this.closed) {
      this.dispose();
      this.invalidated();
    }
  }
  cancel() {
    this.operation?.abort();
  }
  private async run(action: (signal: AbortSignal) => Promise<void>) {
    if (this.operation) return;
    try {
      this.guard();
    } catch {
      this.invalidate();
      return;
    }
    const operation = new AbortController();
    this.operation = operation;
    this.emit({ busy: true, error: '', paused: false });
    try {
      await action(operation.signal);
    } catch (error) {
      try {
        this.guard();
        let task = this.state.task;
        try {
          task = await readAuthorUpload(this.context);
        } catch {
          /* Keep the original failure visible without replacing damaged recovery data. */
        }
        this.emit({
          task,
          error: operation.signal.aborted
            ? ''
            : error instanceof Error
              ? error.message
              : 'The upload could not be confirmed. Its saved copy is kept.',
          paused: operation.signal.aborted,
        });
      } catch {
        this.invalidate();
      }
    } finally {
      if (this.operation === operation) this.operation = null;
      try {
        this.emit({ busy: false, stage: 'idle' });
      } catch {
        this.invalidate();
      }
    }
  }
  async restore() {
    await this.run(async () => {
      this.emit({ stage: 'checking' });
      const task = await readAuthorUpload(this.context);
      this.emit({ task, paused: !!task });
    });
  }
  async start(file: File) {
    await this.run(async (signal) => {
      this.emit({ stage: 'saving' });
      const task = await prepareAuthorUpload(this.context, file, signal);
      this.emit({ task });
      await this.transfer(task, signal);
    });
  }
  async resume() {
    await this.run(async (signal) => {
      this.emit({ stage: 'checking' });
      const task = await readAuthorUpload(this.context);
      if (!task) throw new Error('Choose a PDF to upload.');
      this.emit({ task });
      await this.transfer(task, signal);
    });
  }
  private async transfer(task: AuthorUploadTask, signal: AbortSignal) {
    const check = () => {
      this.guard();
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    };
    check();
    this.emit({ stage: task.upload ? 'checking' : 'reserving' });
    // An unknown reservation retries its exact intent. An unknown transfer always queries status first.
    let receipt = task.upload
      ? await this.client.uploadStatus(task.upload.id, { signal })
      : (await this.client.reserveUpload(task.intent, { signal })).upload;
    check();
    task = await saveAuthorUploadStatus(this.context, task, receipt, signal);
    this.emit({ task });
    check();
    if (receipt.status === 'pending') {
      const file = await readAuthorUploadFile(this.context, task, signal);
      check();
      this.emit({ stage: 'sending' });
      receipt = (await this.client.uploadContent(receipt.id, file, { signal })).upload;
      check();
      task = await saveAuthorUploadStatus(this.context, task, receipt, signal);
      this.emit({ task });
      check();
    }
    if (receipt.status === 'ready') {
      await this.ready();
      check();
    }
  }
}
