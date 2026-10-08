import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { AppendOperation, CommittedOperation } from '../../apps/api/src/sync/types';
import type {
  SubmissionInput,
  SubmissionRequest,
  SubmissionStatus,
  SubmissionReprocessRequest,
} from '../../apps/api/src/assignments/submissions/types';

/** Synthetic browser fixture only. Never mount in an application or deploy as authentication. */
export async function canvasWorkFixture({
  namespace = '20000000',
  title = 'Synthetic Canvas coursework',
}: { namespace?: string; title?: string } = {}) {
  if (!/^[a-f0-9]{8}$/i.test(namespace))
    throw new Error('Use an eight-character hexadecimal fixture namespace.');
  if (
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > 120 ||
    /[\x00-\x1f\x7f]/.test(title)
  )
    throw new Error('Use a bounded printable synthetic fixture title.');
  const id = (n: number) =>
    `${namespace.toLowerCase()}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText(`${title} - local test only`, { x: 48, y: 740, size: 16, font });
  const bytes = Buffer.from(await pdf.save());
  const operations: CommittedOperation[] = [];
  const received: AppendOperation[] = [];
  const createdAt = Date.now() - 1000;
  const captures: SubmissionInput[] = [];
  const submissionRequests = new Map<string, SubmissionRequest>();
  const submissions: SubmissionStatus[] = [];
  const frozenOperations = new Map<string, CommittedOperation[]>();
  const reprocessRequests = new Map<number, SubmissionReprocessRequest>();
  const reprocessPosts: number[] = [];
  const state = {
    authorized: true,
    loseNextAcknowledgement: false,
    sourceReads: 0,
    submissionsConfigured: false,
    loseNextCaptureAcknowledgement: false,
    hideSubmissionRequests: false,
    loseNextReprocessAcknowledgement: false,
    hideReprocessRequests: false,
    rejectNextCapture: null as 'cursor_changed' | 'attempt_exists' | null,
  };
  const json = (value: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
  return {
    state,
    operations,
    received,
    captures,
    submissionRequests,
    submissions,
    frozenOperations,
    reprocessRequests,
    reprocessPosts,
    async handle(url: URL, method: string, body?: string) {
      if (!state.authorized)
        return json(
          { error: { code: 'session_revoked', message: 'Synthetic session was revoked.' } },
          401,
        );
      if (url.pathname === '/api/auth/session')
        return json({
          authenticated: true,
          sessionId: id(1),
          userId: id(2),
          organizationId: id(3),
          role: 'student',
          authenticationMethod: 'lti',
          mfa: false,
          createdAt,
          lastSeenAt: Date.now(),
          expiresAt: createdAt + 3_600_000,
          csrfToken: 'a'.repeat(43),
        });
      if (
        url.pathname === '/api/assignments/work/submissions' ||
        url.pathname.startsWith('/api/assignments/work/submissions/') ||
        url.pathname.startsWith('/api/assignments/work/submission-requests/')
      ) {
        if (!state.submissionsConfigured)
          return json(
            {
              error: { code: 'submission_unconfigured', message: 'Synthetic capture is disabled.' },
            },
            503,
          );
        if (url.pathname.includes('/reprocess')) {
          const submission = submissions.find((row) => row.id === url.pathname.split('/')[5]);
          const request = submission && submissionRequests.get(submission.requestId);
          if (!request || request.state !== 'captured')
            return json(
              { error: { code: 'submission_missing', message: 'Unknown synthetic submission.' } },
              404,
            );
          const expectedRevision =
            method === 'POST'
              ? (JSON.parse(body ?? '{}').expectedRevision as number)
              : Number(url.pathname.split('/').at(-1));
          let result = reprocessRequests.get(expectedRevision);
          if (method === 'POST') {
            reprocessPosts.push(expectedRevision);
            if (expectedRevision > request.submission.revision)
              return json(
                { error: { code: 'revision_changed', message: 'Synthetic future revision.' } },
                409,
              );
            if (!result) {
              const code =
                expectedRevision !== request.submission.revision
                  ? 'revision_changed'
                  : !request.submission.retryAllowed
                    ? 'not_retryable'
                    : null;
              if (!code)
                Object.assign(request.submission, {
                  revision: expectedRevision + 1,
                  phase: 'processing',
                  retryAllowed: false,
                  errorCode: null,
                });
              result = {
                request: structuredClone(request),
                expectedRevision,
                state: code ? 'rejected' : 'accepted',
                acceptedRevision: code ? null : expectedRevision + 1,
                code,
              };
              reprocessRequests.set(expectedRevision, result);
            }
            if (state.loseNextReprocessAcknowledgement) {
              state.loseNextReprocessAcknowledgement = false;
              return json(
                {
                  error: {
                    code: 'synthetic_retry_ack_unavailable',
                    message: 'Synthetic interruption after durable retry.',
                  },
                },
                503,
              );
            }
          }
          if (!result || (method === 'GET' && state.hideReprocessRequests))
            return json(
              {
                error: {
                  code: 'submission_reprocess_missing',
                  message: 'Unknown synthetic retry.',
                },
              },
              404,
            );
          return json(
            { ...result, request },
            method === 'GET' ? 200 : result.state === 'accepted' ? 202 : 409,
          );
        }
        if (url.pathname.startsWith('/api/assignments/work/submission-requests/')) {
          if (state.hideSubmissionRequests)
            return json(
              {
                error: {
                  code: 'synthetic_status_unavailable',
                  message: 'Synthetic status interruption.',
                },
              },
              503,
            );
          const request = submissionRequests.get(url.pathname.split('/').at(-1)!);
          return request
            ? json({ request })
            : json(
                {
                  error: {
                    code: 'submission_request_not_found',
                    message: 'Unknown synthetic request.',
                  },
                },
                404,
              );
        }
        if (method === 'GET') return json({ submissions, nextCursor: null });
        if (method !== 'POST')
          return json(
            { error: { code: 'method_not_allowed', message: 'Synthetic route method.' } },
            405,
          );
        const input = JSON.parse(body ?? '{}') as SubmissionInput;
        captures.push(structuredClone(input));
        let request = submissionRequests.get(input.requestId);
        const duplicate = !!request;
        if (request && request.expectedCursor !== input.expectedCursor)
          return json(
            {
              error: { code: 'submission_request_conflict', message: 'The exact request changed.' },
            },
            409,
          );
        if (!request) {
          const rejection =
            state.rejectNextCapture ??
            (submissions.length
              ? 'attempt_exists'
              : input.expectedCursor !== operations.length
                ? 'cursor_changed'
                : null);
          state.rejectNextCapture = null;
          if (rejection) request = { ...input, state: 'rejected', code: rejection };
          else {
            const submission: SubmissionStatus = {
              id: id(100 + submissions.length),
              requestId: input.requestId,
              attempt: 1,
              frozenCursor: operations.length,
              frozenAt: new Date().toISOString(),
              revision: 1,
              phase: 'processing',
              confirmedAt: null,
              retryAllowed: false,
              errorCode: null,
            };
            submissions.push(submission);
            frozenOperations.set(submission.id, structuredClone(operations));
            request = { ...input, state: 'captured', submission };
          }
          submissionRequests.set(input.requestId, request);
        }
        if (state.loseNextCaptureAcknowledgement) {
          state.loseNextCaptureAcknowledgement = false;
          return json(
            {
              error: {
                code: 'synthetic_capture_ack_unavailable',
                message: 'Synthetic interruption after durable capture.',
              },
            },
            503,
          );
        }
        return json(
          { request, duplicate },
          request.state === 'rejected' ? 409 : request.submission.phase === 'confirmed' ? 200 : 202,
        );
      }
      if (url.pathname === '/api/assignments/work/source') {
        state.sourceReads++;
        return { status: 200, contentType: 'application/pdf', body: bytes };
      }
      if (url.pathname === '/api/assignments/work')
        return json({
          assignment: {
            id: id(4),
            title,
            instructions: 'Add a short text note. This fixture contains no student data.',
            policy: {
              allowedTools: ['text', 'eraser'],
              assessment: false,
              allowExport: true,
              allowCopyPaste: true,
              allowReadAloud: true,
            },
          },
          work: {
            id: id(5),
            status: 'provisioned',
            document: {
              documentId: id(6),
              versionId: id(7),
              cursor: operations.length,
              permission: 'owner',
              audience: 'members',
              pages: [{ id: id(8), index: 0, width: 612, height: 792 }],
            },
          },
        });
      if (url.pathname === '/api/assignments/work/operations' && method === 'GET') {
        const after = Number(url.searchParams.get('afterCursor') ?? 0),
          limit = Number(url.searchParams.get('limit') ?? 100);
        const batch = operations.filter((operation) => operation.cursor > after).slice(0, limit);
        const nextCursor = batch.at(-1)?.cursor ?? after;
        return json({
          documentId: id(6),
          versionId: id(7),
          operations: batch,
          nextCursor,
          currentCursor: operations.length,
          hasMore: nextCursor < operations.length,
        });
      }
      if (url.pathname === '/api/assignments/work/operations' && method === 'POST') {
        const operation = JSON.parse(body ?? '{}') as AppendOperation;
        received.push(structuredClone(operation));
        const existing = operations.find((item) => item.operationId === operation.operationId);
        if (
          existing &&
          JSON.stringify(received.find((item) => item.operationId === operation.operationId)) !==
            JSON.stringify(operation)
        )
          return json(
            { error: { code: 'operation_conflict', message: 'The exact operation changed.' } },
            409,
          );
        const previous = operations
          .filter((item) => item.annotationId === operation.annotationId)
          .at(-1);
        if (!existing && operation.baseRevision !== (previous?.annotationRevision ?? 0))
          return json(
            { error: { code: 'annotation_conflict', message: 'The annotation changed.' } },
            409,
          );
        const committed = existing ?? {
          ...operation,
          actorId: id(2),
          cursor: operations.length + 1,
          annotationRevision: operation.baseRevision + 1,
          committedAt: new Date().toISOString(),
        };
        if (!existing) operations.push(committed);
        if (state.loseNextAcknowledgement) {
          state.loseNextAcknowledgement = false;
          return json(
            {
              error: {
                code: 'synthetic_receipt_unavailable',
                message: 'Synthetic interruption after commit.',
              },
            },
            503,
          );
        }
        return json({
          receipt: {
            operationId: operation.operationId,
            cursor: committed.cursor,
            annotationRevision: committed.annotationRevision,
            duplicate: !!existing,
          },
        });
      }
      return json(
        {
          error: {
            code: 'fixture_route_missing',
            message: 'This route is not part of the synthetic fixture.',
          },
        },
        404,
      );
    },
  };
}
