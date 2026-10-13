import type { PoolClient, PoolConfig } from 'pg';
import type { KeyManagementProvider, WrappedDataKey } from '../../encryption.js';
import type { SessionPrincipal } from '../../identity/types.js';
import type { PostgresIngestionRepository } from '../../ingestion/postgres.js';
import { bounded } from '../../cloud/limits.js';
import {
  decrypt,
  encrypt,
  newWrappedKey,
  unwrapKey,
  type Ciphertext,
} from '../../sync/encryption.js';
import { canonical } from '../../sync/validation.js';
import { AssignmentError } from '../types.js';
import { WorkAuthority, type WorkSnapshot } from '../work/authority.js';
import type { Decoded } from '../work/manifest.js';
import { authority, lockCurrent, type ReviewAuthority } from '../review/pool.js';
import {
  descriptor,
  metadataSql,
  openCompletion,
  type ChunkMetadata,
  type CompletionManifest,
  type CompletionRow,
} from '../review/materialization.js';
import { authenticate } from '../submissions/processing/envelope.js';
import {
  capture,
  fingerprint,
  fresh,
  hash,
  lockAuthority,
  type Snapshot,
} from '../submissions/processing/authority.js';
import { SubmissionProviderAdmission } from '../submissions/processing/providers.js';
import { SubmissionProcessingError } from '../submissions/processing/types.js';
import { FeedbackPool, check, unavailable } from './pool.js';
import { feedbackId, parseFeedbackCommand, parseFeedbackContent } from './validation.js';
import type {
  AssignmentFeedbackService,
  FeedbackCapture,
  FeedbackCommand,
  FeedbackContent,
  FeedbackOptions,
  FeedbackRelease,
  ReleaseFeedbackInput,
  SaveFeedbackInput,
  StudentFeedback,
  TeacherFeedback,
} from './types.js';

interface Row extends Ciphertext {
  submission_id: string;
  organization_id: string;
  work_id: string;
  snapshot_pin: string;
  revision: number;
  saved_at?: Date;
  released_at?: Date;
  wrapped_key: WrappedDataKey;
}
interface CommandRow extends Ciphertext {
  submission_id: string;
  organization_id: string;
  work_id: string;
  snapshot_pin: string;
  request_id: string;
  action: 'save' | 'release';
  expected_revision: number;
  wrapped_key: WrappedDataKey;
}
interface Job {
  claim_id: string;
  materialization_attempt: number;
  materialization_state: string;
}
interface Prepared {
  snapshot: Snapshot;
  teacher: ReviewAuthority | null;
  student: WorkSnapshot | null;
  decoded: Decoded;
  receipt: CompletionRow;
  job: Job;
  manifest: CompletionManifest;
  capture: FeedbackCapture;
  draft: Row | null;
  release: Row | null;
  command: CommandRow | null;
}
const integrity = () =>
  new AssignmentError(
    503,
    'feedback_integrity',
    'The saved feedback could not be authenticated. Keep your edits and try again.',
  );
const changed = () =>
  new AssignmentError(
    409,
    'feedback_snapshot_changed',
    'Reopen this captured submission before saving feedback.',
  );
const notReady = () =>
  new AssignmentError(
    409,
    'feedback_not_ready',
    'The captured submission is not ready for feedback.',
  );
const jobSql = `SELECT claim_id,materialization_attempt,materialization_state FROM margin_submissions.outbox WHERE attempt_id=$1`;
const empty = (): FeedbackContent => ({ comment: '', annotations: [] });
const same = (a: unknown, b: unknown) => fingerprint(a) === fingerprint(b);
class RetryRead extends Error {}
const stamp = (v: Date | undefined) => {
  if (!v || !Number.isFinite(v.getTime())) throw integrity();
  return v.toISOString();
};
const context = (kind: 'draft' | 'release' | 'command', r: Row | CommandRow) =>
  canonical([
    'margin-feedback-v1',
    kind,
    r.organization_id,
    r.work_id,
    r.submission_id,
    r.snapshot_pin,
    kind === 'command'
      ? [
          (r as CommandRow).request_id,
          (r as CommandRow).action,
          (r as CommandRow).expected_revision,
        ]
      : [
          (r as Row).revision,
          kind === 'draft' ? stamp((r as Row).saved_at) : stamp((r as Row).released_at),
        ],
  ]);

/** Independent encrypted feedback. No writes to the student's capture, annotations or draft. */
export class PostgresAssignmentFeedbackService implements AssignmentFeedbackService {
  private readonly pool: FeedbackPool;
  private readonly work: WorkAuthority;
  private readonly external = new SubmissionProviderAdmission();
  private readonly keys: KeyManagementProvider;
  private active = 0;
  constructor(
    database: PoolConfig,
    keys: KeyManagementProvider,
    private readonly reader: PostgresIngestionRepository,
  ) {
    if (reader.purpose !== 'reader') throw Error('Feedback requires an ingestion reader.');
    this.pool = new FeedbackPool(database);
    this.keys = this.external.keys(keys);
    this.work = new WorkAuthority(this.pool, this.keys);
  }
  async close() {
    this.external.close();
    await this.pool.close();
  }
  private async run<T>(
    p: SessionPrincipal,
    role: 'teacher' | 'student',
    options: FeedbackOptions,
    fn: (principal: SessionPrincipal, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (p.authenticationMethod !== 'lti' || p.role !== role) throw unavailable();
    check(options.signal);
    if (this.active >= 2)
      throw new AssignmentError(503, 'feedback_busy', 'Feedback is busy. Retry shortly.');
    this.external.assertAvailable();
    this.active++;
    let started = false;
    try {
      return await bounded(60000, options.signal, async (signal) => {
        started = true;
        try {
          return await fn({ ...p }, signal);
        } finally {
          this.active--;
        }
      });
    } catch (error) {
      if (error instanceof AssignmentError) throw error;
      if (options.signal?.aborted) check(options.signal);
      if (
        error instanceof SubmissionProcessingError &&
        ['submission_unavailable', 'authority_revoked'].includes(error.code)
      )
        throw unavailable();
      throw integrity();
    } finally {
      if (!started) this.active--;
    }
  }
  private async scope(c: PoolClient, id: string) {
    for (const ns of ['margin_feedback', 'margin_review'])
      await c.query('SELECT set_config($1,$2,true)', [ns + '.submission_id', id]);
  }
  private async rows(c: PoolClient, id: string, teacher: boolean, requestId?: string) {
    const draft = teacher
      ? ((await c.query<Row>('SELECT * FROM margin_feedback.drafts WHERE submission_id=$1', [id]))
          .rows[0] ?? null)
      : null;
    const release =
      (
        await c.query<Row>(
          'SELECT * FROM margin_feedback.releases WHERE submission_id=$1 ORDER BY revision DESC LIMIT 1',
          [id],
        )
      ).rows[0] ?? null;
    const command =
      teacher && requestId
        ? ((
            await c.query<CommandRow>(
              'SELECT * FROM margin_feedback.commands WHERE submission_id=$1 AND request_id=$2',
              [id, requestId],
            )
          ).rows[0] ?? null)
        : null;
    return { draft, release, command };
  }
  private async prepare(
    p: SessionPrincipal,
    id: string,
    signal: AbortSignal,
    requestId?: string,
  ): Promise<Prepared> {
    const initial = await this.pool.transaction(
      p,
      async (c) => {
        await this.scope(c, id);
        const teacher = p.role === 'teacher' ? await authority(c) : null;
        const student = p.role === 'student' ? await this.work.capture(c) : null;
        const snapshot = await capture(c, id);
        if (
          (teacher && snapshot.assignment.id !== teacher.assignment.id) ||
          (student && (snapshot.work.id !== student.work?.id || snapshot.work.user_id !== p.userId))
        )
          throw unavailable();
        const job = (await c.query<Job>(jobSql, [id])).rows[0];
        const receipt = (
          await c.query<CompletionRow>(
            'SELECT * FROM margin_submissions.materialization_receipts WHERE submission_id=$1',
            [id],
          )
        ).rows[0];
        if (
          !job ||
          job.materialization_state !== 'completed' ||
          !receipt ||
          job.claim_id !== receipt.claim_id ||
          job.materialization_attempt !== receipt.attempt
        )
          throw notReady();
        return {
          snapshot,
          teacher,
          student,
          job,
          receipt,
          ...(await this.rows(c, id, p.role === 'teacher', requestId)),
        };
      },
      signal,
    );
    const opened = await authenticate(this.keys, initial.snapshot);
    const manifest = await openCompletion(
      this.keys,
      initial.snapshot,
      initial.receipt,
      opened.bytes,
    );
    const source = await bounded(10000, signal, () =>
      this.external.run(() => this.reader.readySnapshot(opened.decoded.source)),
    );
    check(signal);
    if (
      !source ||
      !opened.decoded.completion ||
      source.stateToken !== opened.decoded.completion.approval ||
      !same(source.receipt, opened.decoded.completion.storage) ||
      !same(
        source.pageGeometry,
        initial.snapshot.pages.map(({ id: _, ...page }) => page),
      ) ||
      !Number.isSafeInteger(source.plaintextBytes) ||
      source.plaintextBytes! < 1 ||
      source.plaintextBytes! > 104857600
    )
      throw integrity();
    const s = initial.snapshot;
    return {
      ...initial,
      decoded: opened.decoded,
      manifest,
      capture: {
        submissionId: id,
        snapshotPin: initial.receipt.manifest_sha256,
        documentId: s.work.document_id,
        versionId: s.work.version_id,
        frozenCursor: Number(s.attempt.frozen_cursor),
        frozenAt: opened.frozenAt,
        pages: s.pages,
        source: {
          sha256: opened.decoded.source.sha256,
          bytes: source.plaintextBytes!,
          mimeType: 'application/pdf',
        },
      },
    };
  }
  private async verify(c: PoolClient, p: SessionPrincipal, v: Prepared, signal: AbortSignal) {
    const id = v.snapshot.attempt.id;
    await this.scope(c, id);
    if (v.teacher) await lockCurrent(c, v.teacher);
    if (v.student) {
      await this.work.locks(c, p, v.student, v.decoded);
      await this.work.fresh(c, v.student, v.decoded, signal);
    }
    await lockAuthority(c, v.snapshot, v.decoded);
    await fresh(c, v.snapshot, v.decoded, signal);
    const receipt = (
      await c.query<CompletionRow>(
        'SELECT * FROM margin_submissions.materialization_receipts WHERE submission_id=$1',
        [id],
      )
    ).rows[0];
    const job = (await c.query<Job>(jobSql, [id])).rows[0];
    if (!same(receipt, v.receipt) || !same(job, v.job)) throw changed();
    const chunks = (await c.query<ChunkMetadata>(metadataSql, [id, v.receipt.claim_id])).rows;
    if (
      chunks.some((r) => r.attempt !== v.receipt.attempt) ||
      !same(chunks.map(descriptor), v.manifest.chunks)
    )
      throw integrity();
    check(signal);
  }
  private identity(v: Prepared) {
    const s = v.snapshot;
    return {
      submission_id: s.attempt.id,
      organization_id: s.work.organization_id,
      work_id: s.work.id,
      snapshot_pin: v.capture.snapshotPin,
    };
  }
  private async seal(
    kind: 'draft' | 'release' | 'command',
    row:
      | Omit<Row, 'ciphertext' | 'nonce' | 'tag' | 'wrapped_key'>
      | Omit<CommandRow, 'ciphertext' | 'nonce' | 'tag' | 'wrapped_key'>,
    payload: unknown,
  ): Promise<Row | CommandRow> {
    const aad = context(kind, row as Row | CommandRow);
    const wrapped_key = await newWrappedKey(this.keys, aad);
    let key: Buffer | undefined, plain: Buffer | undefined;
    try {
      key = await unwrapKey(this.keys, wrapped_key, aad);
      plain = Buffer.from(canonical({ schema: 1, context: aad, payload }));
      if (plain.length > 262144)
        throw new AssignmentError(
          413,
          'feedback_too_large',
          'Reduce the feedback size before saving.',
        );
      return { ...row, ...encrypt(key, plain, aad), wrapped_key } as Row | CommandRow;
    } finally {
      key?.fill(0);
      plain?.fill(0);
    }
  }
  private async open(
    kind: 'draft' | 'release' | 'command',
    row: Row | CommandRow,
    v: Prepared,
  ): Promise<unknown> {
    if (
      !same(
        Object.fromEntries(
          Object.keys(this.identity(v)).map((k) => [
            k,
            (row as unknown as Record<string, unknown>)[k],
          ]),
        ),
        this.identity(v),
      )
    )
      throw integrity();
    const aad = context(kind, row);
    let key: Buffer | undefined, plain: Buffer | undefined;
    try {
      key = await unwrapKey(this.keys, row.wrapped_key, aad);
      plain = decrypt(key, row, aad, 262144);
      const body = JSON.parse(plain.toString('utf8'));
      if (
        canonical(body) !== plain.toString('utf8') ||
        Object.keys(body).sort().join(',') !== 'context,payload,schema' ||
        body.schema !== 1 ||
        body.context !== aad
      )
        throw integrity();
      return body.payload;
    } finally {
      key?.fill(0);
      plain?.fill(0);
    }
  }
  private async content(
    kind: 'draft' | 'release',
    row: Row,
    v: Prepared,
  ): Promise<FeedbackContent> {
    try {
      const data = await this.open(kind, row, v);
      const parsed = parseFeedbackContent(data, v.capture);
      if (canonical(data) !== canonical(parsed)) throw integrity();
      return parsed;
    } catch {
      throw integrity();
    }
  }
  private async outcome(
    row: CommandRow,
    v: Prepared,
    inputHash?: string,
  ): Promise<FeedbackCommand> {
    const value = (await this.open('command', row, v)) as {
      inputHash: string;
      outcome: FeedbackCommand;
    };
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'inputHash,outcome' ||
      typeof value.inputHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.inputHash)
    )
      throw integrity();
    if (inputHash !== undefined && inputHash !== value.inputHash)
      throw new AssignmentError(
        409,
        'feedback_request_conflict',
        'This request identifier already describes different feedback. Recover the original request.',
      );
    const o = value.outcome;
    if (
      !o ||
      Object.keys(o).sort().join(',') !==
        'action,code,expectedRevision,releasedAt,requestId,revision,savedAt,snapshotPin,state' ||
      o.requestId !== row.request_id ||
      o.action !== row.action ||
      o.snapshotPin !== row.snapshot_pin ||
      o.expectedRevision !== row.expected_revision ||
      !Number.isSafeInteger(o.revision) ||
      o.revision < 0 ||
      o.revision > 100000 ||
      !['accepted', 'rejected'].includes(o.state) ||
      (o.state === 'accepted'
        ? o.code !== null
        : !['revision_changed', 'draft_required'].includes(o.code!)) ||
      (o.savedAt !== null &&
        (!Number.isFinite(Date.parse(o.savedAt)) ||
          new Date(o.savedAt).toISOString() !== o.savedAt)) ||
      (o.releasedAt !== null &&
        (!Number.isFinite(Date.parse(o.releasedAt)) ||
          new Date(o.releasedAt).toISOString() !== o.releasedAt)) ||
      (o.revision === 0) !== (o.savedAt === null) ||
      (o.state === 'accepted' &&
        o.action === 'save' &&
        (o.revision !== o.expectedRevision + 1 || o.releasedAt !== null)) ||
      (o.state === 'accepted' &&
        o.action === 'release' &&
        (o.revision !== o.expectedRevision ||
          o.revision < 1 ||
          o.releasedAt === null ||
          Date.parse(o.releasedAt) < Date.parse(o.savedAt!))) ||
      (o.state === 'rejected' &&
        (o.releasedAt !== null ||
          (o.code === 'draft_required'
            ? o.revision !== 0 || o.expectedRevision !== 0
            : o.revision <= o.expectedRevision)))
    )
      throw integrity();
    return o;
  }
  teacher(
    p: SessionPrincipal,
    id: string,
    options: FeedbackOptions = {},
  ): Promise<TeacherFeedback> {
    id = feedbackId(id);
    return this.run(p, 'teacher', options, async (principal, signal) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const v = await this.prepare(principal, id, signal);
        const content = v.draft ? await this.content('draft', v.draft, v) : empty();
        const released: FeedbackRelease | null = v.release
          ? {
              revision: v.release.revision,
              releasedAt: stamp(v.release.released_at),
              content: await this.content('release', v.release, v),
            }
          : null;
        try {
          return await this.pool.transaction(
            principal,
            async (c) => {
              await this.verify(c, principal, v, signal);
              const current = await this.rows(c, id, true);
              if (!same(current.draft, v.draft) || !same(current.release, v.release))
                throw new RetryRead();
              return {
                capture: v.capture,
                revision: v.draft?.revision ?? 0,
                savedAt: v.draft ? stamp(v.draft.saved_at) : null,
                content,
                released,
              };
            },
            signal,
          );
        } catch (e) {
          if (!(e instanceof RetryRead)) throw e;
        }
      }
      throw new AssignmentError(
        409,
        'feedback_changed',
        'Feedback changed in another tab. Reload it before continuing.',
      );
    });
  }
  student(
    p: SessionPrincipal,
    id: string,
    options: FeedbackOptions = {},
  ): Promise<StudentFeedback> {
    id = feedbackId(id);
    return this.run(p, 'student', options, async (principal, signal) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const v = await this.prepare(principal, id, signal);
        const released = v.release
          ? {
              revision: v.release.revision,
              releasedAt: stamp(v.release.released_at),
              content: await this.content('release', v.release, v),
            }
          : null;
        try {
          return await this.pool.transaction(
            principal,
            async (c) => {
              await this.verify(c, principal, v, signal);
              if (!same((await this.rows(c, id, false)).release, v.release)) throw new RetryRead();
              return { capture: v.capture, released };
            },
            signal,
          );
        } catch (e) {
          if (!(e instanceof RetryRead)) throw e;
        }
      }
      throw new AssignmentError(
        409,
        'feedback_changed',
        'New feedback became available. Refresh to read it.',
      );
    });
  }
  command(
    p: SessionPrincipal,
    id: string,
    requestId: string,
    options: FeedbackOptions = {},
  ): Promise<FeedbackCommand> {
    id = feedbackId(id);
    requestId = feedbackId(requestId);
    return this.run(p, 'teacher', options, async (principal, signal) => {
      const v = await this.prepare(principal, id, signal, requestId);
      if (!v.command)
        throw new AssignmentError(
          404,
          'feedback_command_not_found',
          'This feedback request has no saved outcome. Retry the exact request.',
        );
      const result = await this.outcome(v.command, v);
      return this.pool.transaction(
        principal,
        async (c) => {
          await this.verify(c, principal, v, signal);
          if (!same((await this.rows(c, id, true, requestId)).command, v.command))
            throw integrity();
          return result;
        },
        signal,
      );
    });
  }
  save(
    p: SessionPrincipal,
    id: string,
    input: unknown,
    options: FeedbackOptions = {},
  ): Promise<FeedbackCommand> {
    return this.mutate(p, id, input, 'save', options);
  }
  release(
    p: SessionPrincipal,
    id: string,
    input: unknown,
    options: FeedbackOptions = {},
  ): Promise<FeedbackCommand> {
    return this.mutate(p, id, input, 'release', options);
  }
  private mutate(
    p: SessionPrincipal,
    id: string,
    input: unknown,
    action: 'save' | 'release',
    options: FeedbackOptions,
  ): Promise<FeedbackCommand> {
    id = feedbackId(id);
    const raw = parseFeedbackCommand(input, action);
    // Clone untrusted nested content before the first asynchronous operation.
    const supplied = structuredClone(raw);
    return this.run(p, 'teacher', options, async (principal, signal) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const v = await this.prepare(principal, id, signal, supplied.requestId);
        if (supplied.snapshotPin !== v.capture.snapshotPin) throw changed();
        const content =
          action === 'save'
            ? parseFeedbackContent((supplied as SaveFeedbackInput).content, v.capture)
            : null;
        const parsed: SaveFeedbackInput | ReleaseFeedbackInput = {
          ...supplied,
          ...(content ? { content } : {}),
        };
        const inputHash = hash(canonical({ action, input: parsed }));
        if (v.command) {
          const outcome = await this.outcome(v.command, v, inputHash);
          return this.pool.transaction(
            principal,
            async (c) => {
              await this.verify(c, principal, v, signal);
              if (!same((await this.rows(c, id, true, supplied.requestId)).command, v.command))
                throw integrity();
              return outcome;
            },
            signal,
          );
        }
        // Authenticate existing metadata through its envelope before deriving a next
        // revision or reusing a prior return timestamp. Corruption is never overwritten.
        const priorContent = v.draft ? await this.content('draft', v.draft, v) : null;
        if (v.release) await this.content('release', v.release, v);
        const revision = v.draft?.revision ?? 0;
        if (supplied.expectedRevision > revision)
          throw new AssignmentError(
            409,
            'feedback_revision_future',
            'Reload feedback before using a future revision.',
          );
        if (revision >= 100000 && action === 'save')
          throw new AssignmentError(
            409,
            'feedback_revision_limit',
            'This feedback has reached its saved revision limit.',
          );
        const accepted =
          supplied.expectedRevision === revision && (action === 'save' || revision > 0);
        const now = new Date(
          Math.max(
            Date.now(),
            v.draft?.saved_at?.getTime() ?? 0,
            v.release?.released_at?.getTime() ?? 0,
          ),
        );
        const outcome: FeedbackCommand = {
          requestId: supplied.requestId,
          action,
          expectedRevision: supplied.expectedRevision,
          snapshotPin: v.capture.snapshotPin,
          state: accepted ? 'accepted' : 'rejected',
          revision: accepted && action === 'save' ? revision + 1 : revision,
          code: accepted
            ? null
            : supplied.expectedRevision !== revision
              ? 'revision_changed'
              : 'draft_required',
          savedAt:
            accepted && action === 'save'
              ? now.toISOString()
              : v.draft
                ? stamp(v.draft.saved_at)
                : null,
          releasedAt:
            accepted && action === 'release'
              ? v.release?.revision === revision
                ? stamp(v.release.released_at)
                : now.toISOString()
              : null,
        };
        const draft =
          accepted && action === 'save'
            ? ((await this.seal(
                'draft',
                { ...this.identity(v), revision: revision + 1, saved_at: now },
                content,
              )) as Row)
            : null;
        const release =
          accepted && action === 'release' && v.release?.revision !== revision
            ? ((await this.seal(
                'release',
                { ...this.identity(v), revision, released_at: now },
                priorContent,
              )) as Row)
            : null;
        const command = (await this.seal(
          'command',
          {
            ...this.identity(v),
            request_id: supplied.requestId,
            action,
            expected_revision: supplied.expectedRevision,
          },
          { inputHash, outcome },
        )) as CommandRow;
        try {
          return await this.pool.transaction(
            principal,
            async (c) => {
              // Take a separate command lock before authority row locks. This avoids a pair of
              // writers deadlocking while upgrading the shared immutable-capture lock.
              await c.query(
                "SELECT pg_advisory_xact_lock(hashtextextended('margin-feedback:'||$1,0))",
                [id],
              );
              await this.verify(c, principal, v, signal);
              const current = await this.rows(c, id, true, supplied.requestId);
              if (
                !same(current.draft, v.draft) ||
                !same(current.release, v.release) ||
                current.command
              )
                throw new RetryRead();
              const count = (
                await c.query<{ n: number }>(
                  'SELECT count(*)::integer AS n FROM (SELECT 1 FROM margin_feedback.commands WHERE submission_id=$1 LIMIT 10000) c',
                  [id],
                )
              ).rows[0].n;
              if (count >= 10000)
                throw new AssignmentError(
                  409,
                  'feedback_history_limit',
                  'The feedback request history is full. Existing feedback is preserved.',
                );
              if (draft) {
                const vals = [
                  id,
                  draft.organization_id,
                  draft.work_id,
                  draft.snapshot_pin,
                  draft.revision,
                  draft.saved_at,
                  draft.ciphertext,
                  draft.nonce,
                  draft.tag,
                  draft.wrapped_key,
                ];
                if (v.draft)
                  await c.query(
                    'UPDATE margin_feedback.drafts SET revision=$5,saved_at=$6,ciphertext=$7,nonce=$8,tag=$9,wrapped_key=$10 WHERE submission_id=$1 AND organization_id=$2 AND work_id=$3 AND snapshot_pin=$4',
                    vals,
                  );
                else
                  await c.query(
                    'INSERT INTO margin_feedback.drafts(submission_id,organization_id,work_id,snapshot_pin,revision,saved_at,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                    vals,
                  );
              }
              if (release)
                await c.query(
                  'INSERT INTO margin_feedback.releases(submission_id,organization_id,work_id,snapshot_pin,revision,released_at,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                  [
                    id,
                    release.organization_id,
                    release.work_id,
                    release.snapshot_pin,
                    release.revision,
                    release.released_at,
                    release.ciphertext,
                    release.nonce,
                    release.tag,
                    release.wrapped_key,
                  ],
                );
              await c.query(
                'INSERT INTO margin_feedback.commands(submission_id,organization_id,work_id,snapshot_pin,request_id,action,expected_revision,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
                [
                  id,
                  command.organization_id,
                  command.work_id,
                  command.snapshot_pin,
                  command.request_id,
                  command.action,
                  command.expected_revision,
                  command.ciphertext,
                  command.nonce,
                  command.tag,
                  command.wrapped_key,
                ],
              );
              return outcome;
            },
            signal,
          );
        } catch (e) {
          if (!(e instanceof RetryRead)) throw e;
        }
      }
      throw new AssignmentError(
        409,
        'feedback_changed',
        'Feedback changed in another tab. Recover this request, then reload before editing.',
      );
    });
  }
}
