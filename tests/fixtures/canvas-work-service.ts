import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { AppendOperation, CommittedOperation } from '../../apps/api/src/sync/types';

/** Synthetic browser fixture only. Never mount in an application or deploy as authentication. */
export async function canvasWorkFixture() {
  const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf
    .addPage([612, 792])
    .drawText('Synthetic Canvas coursework - local test only', { x: 48, y: 740, size: 16, font });
  const bytes = Buffer.from(await pdf.save());
  const operations: CommittedOperation[] = [];
  const received: AppendOperation[] = [];
  const createdAt = Date.now() - 1000;
  const state = { authorized: true, loseNextAcknowledgement: false, sourceReads: 0 };
  const json = (value: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
  return {
    state,
    operations,
    received,
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
      if (url.pathname === '/api/assignments/work/source') {
        state.sourceReads++;
        return { status: 200, contentType: 'application/pdf', body: bytes };
      }
      if (url.pathname === '/api/assignments/work')
        return json({
          assignment: {
            id: id(4),
            title: 'Synthetic Canvas coursework',
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
