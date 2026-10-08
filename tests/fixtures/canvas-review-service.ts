import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type {
  ReviewChunk,
  ReviewContext,
  ReviewSnapshot,
  ReviewSubmission,
} from '../../apps/api/src/assignments/review/types';
import { canonical } from '../../apps/api/src/sync/validation';

/** Synthetic browser transport only; never mount in the application runtime. */
export async function canvasReviewFixture() {
  const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const createdAt = Date.now() - 3_600_000;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica),
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let index = 0; index < 2; index++) {
    const page = pdf.addPage([612, 792]);
    page.drawText('SYNTHETIC CLASSROOM DOCUMENT', {
      x: 48,
      y: 744,
      size: 9,
      font,
      color: rgb(0.48, 0.48, 0.44),
    });
    page.drawText(index ? 'Explain your thinking' : 'Reading between the lines', {
      x: 48,
      y: 690,
      size: 25,
      font: bold,
      color: rgb(0.18, 0.2, 0.17),
    });
    page.drawText(
      index
        ? 'What changed when you read the passage a second time?'
        : 'Read closely. Find a detail that changes the meaning.',
      { x: 48, y: 651, size: 12, font },
    );
    const lines = index
      ? [
          'Use evidence from the passage to support your response.',
          "Consider the image, the setting, and the narrator's choice of words.",
        ]
      : [
          'The old garden gate stood open, though nobody remembered',
          'unlocking it. Beyond it, the path curved into morning light.',
          'Mira paused at the threshold, listening. Somewhere among',
          'the trees, a familiar voice was calling her name.',
        ];
    lines.forEach((line, lineIndex) =>
      page.drawText(line, { x: 48, y: 590 - lineIndex * 25, size: 13, font }),
    );
    page.drawLine({
      start: { x: 48, y: 442 },
      end: { x: 564, y: 442 },
      thickness: 0.6,
      color: rgb(0.8, 0.8, 0.75),
    });
    page.drawText('YOUR RESPONSE', {
      x: 48,
      y: 420,
      size: 9,
      font: bold,
      color: rgb(0.48, 0.48, 0.44),
    });
    page.drawText(
      `Synthetic test only - no school or student data                     ${index + 1} / 2`,
      { x: 48, y: 40, size: 9, font },
    );
  }
  const bytes = Buffer.from(await pdf.save());
  const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
  const context: ReviewContext = {
    assignment: {
      id: id(10),
      title: 'Synthetic literature review',
      instructions: 'Read both pages. Highlight one detail and explain your interpretation.',
    },
    mode: 'author-only',
  };
  const submissions: ReviewSubmission[] = Array.from({ length: 22 }, (_, index) => ({
    id: id(100 + index),
    frozenAt: new Date(createdAt + index * 1000).toISOString(),
    frozenCursor: 6,
    revision: index === 2 ? 1 : 2,
    preparation: index === 2 ? 'preparing' : index === 3 ? 'failed' : 'ready',
    errorCode: index === 3 ? 'source_unavailable' : null,
  }));
  const chunks = new Map<string, Buffer>(),
    snapshots = new Map<string, ReviewSnapshot>();
  for (const [index, submission] of submissions.entries()) {
    const workId = id(200 + index),
      documentId = id(300 + index),
      versionId = id(400 + index);
    const chunk: ReviewChunk = {
      schema: 1,
      organizationId: id(3),
      workId,
      documentId,
      versionId,
      frozenCursor: 6,
      index: 0,
      entries: [
        {
          annotationId: id(501),
          pageId: id(20),
          revision: 1,
          latestCursor: 2,
          deleted: false,
          layerOrder: 2,
          annotation: {
            type: 'text',
            x: 49,
            y: 394,
            text:
              index === 1
                ? 'The open gate suggests a new beginning.'
                : 'The familiar voice makes the scene feel hopeful.',
            color: '#33342f',
            strokeWidth: 2,
            opacity: 1,
          },
        },
        {
          annotationId: id(502),
          pageId: id(20),
          revision: 1,
          latestCursor: 1,
          deleted: false,
          layerOrder: 1,
          annotation: {
            type: 'highlight',
            x: 48,
            y: 212,
            width: 430,
            height: 21,
            color: '#f1cd67',
            strokeWidth: 2,
            opacity: 0.35,
          },
        },
        {
          annotationId: id(503),
          pageId: id(20),
          revision: 1,
          latestCursor: 3,
          deleted: false,
          layerOrder: 3,
          annotation: {
            type: 'comment',
            x: 507,
            y: 214,
            text: 'Why does the writer describe the morning light here?',
            color: '#af573b',
            strokeWidth: 2,
            opacity: 1,
          },
        },
        {
          annotationId: id(504),
          pageId: id(21),
          revision: 1,
          latestCursor: 4,
          deleted: false,
          layerOrder: 4,
          annotation: {
            type: 'text',
            x: 48,
            y: 394,
            text: "A second reading connects the gate to Mira's decision.",
            color: '#33342f',
            strokeWidth: 2,
            opacity: 1,
          },
        },
        {
          annotationId: id(505),
          pageId: id(20),
          revision: 2,
          latestCursor: 6,
          deleted: true,
          layerOrder: null,
        },
      ],
    };
    const payload = Buffer.from(canonical(chunk));
    chunks.set(submission.id, payload);
    snapshots.set(submission.id, {
      assignmentId: id(10),
      submission,
      snapshotPin: digest(`synthetic-completion-${submission.id}`),
      organizationId: id(3),
      workId,
      documentId,
      versionId,
      pages: [
        { id: id(20), index: 0, width: 612, height: 792 },
        { id: id(21), index: 1, width: 612, height: 792 },
      ],
      source: { sha256: digest(bytes), bytes: bytes.length, mimeType: 'application/pdf' },
      annotationCount: chunk.entries.length,
      outputBytes: payload.length,
      outputSha256: digest(payload),
      chunks: [{ index: 0, sha256: digest(payload), bytes: payload.length }],
    });
  }
  const state = {
    authorized: true,
    role: 'teacher',
    corruptNextChunk: false,
    rejectSource: false,
    denySnapshot: false,
    sourceReads: 0,
    chunkReads: 0,
  };
  const requests: Array<{ pathname: string; method: string }> = [];
  const json = (value: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value) as string | Buffer,
  });
  const error = (code: string, message: string, status: number) =>
    json({ error: { code, message } }, status);
  return {
    state,
    context,
    submissions,
    snapshots,
    requests,
    async handle(url: URL, method: string) {
      requests.push({ pathname: url.pathname, method });
      if (!state.authorized)
        return error('session_revoked', 'The synthetic teacher launch was revoked.', 401);
      if (url.pathname === '/api/auth/session')
        return json({
          authenticated: true,
          sessionId: id(1),
          userId: id(2),
          organizationId: id(3),
          role: state.role,
          authenticationMethod: 'lti',
          mfa: false,
          createdAt,
          lastSeenAt: Date.now(),
          expiresAt: Date.now() + 3_600_000,
          csrfToken: 'a'.repeat(43),
        });
      if (method !== 'GET') return error('read_only', 'Synthetic review is read-only.', 405);
      if (url.pathname === '/api/assignments/review') return json(context);
      if (url.pathname === '/api/assignments/review/submissions') {
        const after = url.searchParams.get('after') ?? '';
        const items = submissions.filter((item) => item.id > after).slice(0, 20);
        return json({
          submissions: items,
          nextCursor: items.length === 20 ? items.at(-1)!.id : null,
        });
      }
      const match =
        /^\/api\/assignments\/review\/submissions\/([^/]+)(?:\/(source|chunks\/0))?$/.exec(
          url.pathname,
        );
      const snapshot = match && snapshots.get(match[1]);
      if (!snapshot || !match) return error('not_found', 'No synthetic review route.', 404);
      if (snapshot.submission.preparation !== 'ready')
        return error('review_not_ready', 'The synthetic capture is not ready.', 409);
      if (!match[2]) {
        if (state.denySnapshot)
          return error(
            'review_unavailable',
            'This synthetic submission is no longer available.',
            404,
          );
        return json(snapshot);
      }
      if (url.searchParams.get('pin') !== snapshot.snapshotPin)
        return error('snapshot_changed', 'The synthetic snapshot pin changed.', 409);
      if (match[2] === 'source') {
        if (state.rejectSource)
          return error('source_unavailable', 'The synthetic source is unavailable.', 409);
        state.sourceReads++;
        return { status: 200, contentType: 'application/pdf', body: bytes };
      }
      state.chunkReads++;
      if (state.corruptNextChunk) {
        state.corruptNextChunk = false;
        return json({ damaged: true });
      }
      return { status: 200, contentType: 'application/json', body: chunks.get(match[1])! };
    },
  };
}
