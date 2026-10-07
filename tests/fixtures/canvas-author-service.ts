import type {
  AuthorAssignment,
  AuthorDraft,
  AuthorSource,
} from '../../apps/web/src/lib/assignment-author/types';

/** Synthetic HTTP fixture only. Never deploy or use as an authentication provider. */
export function canvasAuthorFixture() {
  const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const createdAt = Date.now() - 1000;
  const state = {
    authorized: true,
    role: 'teacher',
    sessionId: id(1),
    userId: id(2),
    organizationId: id(3),
    selectionId: id(4),
    courseId: id(5),
    expiresAt: createdAt + 3_600_000,
    loseNextCreateResponse: false,
    failNextCreate: 0,
    sourceAvailable: true,
    returned: false,
  };
  const sources: AuthorSource[] = Array.from({ length: 6 }, (_, index) => ({
    documentId: id(10 + index),
    versionId: id(20 + index),
    name: `Synthetic worksheet ${index + 1}.pdf`,
    pageCount: index + 1,
    bytes: 1400 + index,
    inspection: 'approved',
    availability: 'not-checked',
  }));
  const received: Array<AuthorDraft & { requestId: string }> = [];
  const assignments = new Map<string, { request: string; assignment: AuthorAssignment }>();
  const returns: Array<{ assignmentId: string; csrfToken: string }> = [];
  const json = (value: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
  const error = (code: string, message: string, status: number) =>
    json({ error: { code, message } }, status);
  return {
    state,
    sources,
    received,
    assignments,
    returns,
    async handle(url: URL, method: string, body?: string) {
      if (!state.authorized)
        return error('session_revoked', 'The synthetic teacher session was revoked.', 401);
      if (url.pathname === '/api/auth/session')
        return json({
          authenticated: true,
          sessionId: state.sessionId,
          userId: state.userId,
          organizationId: state.organizationId,
          role: state.role,
          authenticationMethod: 'lti',
          mfa: false,
          createdAt,
          lastSeenAt: Date.now(),
          expiresAt: state.expiresAt,
          csrfToken: 'a'.repeat(43),
        });
      if (url.pathname === '/api/assignments/selection')
        return json({
          selection: state.returned
            ? null
            : { id: state.selectionId, courseId: state.courseId, expiresAt: state.expiresAt },
        });
      if (url.pathname === '/api/assignments/sources')
        return json({
          sources: url.searchParams.has('after') ? sources.slice(5) : sources.slice(0, 5),
          nextCursor: url.searchParams.has('after') ? null : 'synthetic-page-2',
        });
      if (url.pathname === '/api/assignments' && method === 'POST') {
        const input = JSON.parse(body ?? '{}') as AuthorDraft & { requestId: string };
        received.push(structuredClone(input));
        if (state.failNextCreate) {
          const status = state.failNextCreate;
          state.failNextCreate = 0;
          return error(
            status === 400 ? 'invalid_text' : 'synthetic_rejection',
            'The synthetic request was rejected.',
            status,
          );
        }
        if (!state.sourceAvailable)
          return error('source_not_ready', 'The selected source is no longer available.', 409);
        const previous = assignments.get(input.requestId);
        if (previous && previous.request !== JSON.stringify(input))
          return error('request_conflict', 'The exact create request changed.', 409);
        const assignment = previous?.assignment ?? {
          id: id(100 + assignments.size),
          title: input.title,
          instructions: input.instructions,
          policy: input.policy,
          createdAt: new Date().toISOString(),
        };
        if (!previous)
          assignments.set(input.requestId, {
            request: JSON.stringify(input),
            assignment: structuredClone(assignment),
          });
        if (state.loseNextCreateResponse) {
          state.loseNextCreateResponse = false;
          return error(
            'synthetic_response_lost',
            'Synthetic response interruption after commit.',
            503,
          );
        }
        return json({ assignment }, 201);
      }
      if (
        url.pathname === `/api/assignments/selections/${state.selectionId}/return` &&
        method === 'POST'
      ) {
        const fields = new URLSearchParams(body);
        if (
          [...fields.keys()].sort().join(',') !== 'assignmentId,csrfToken' ||
          fields.get('csrfToken') !== 'a'.repeat(43)
        )
          return error('invalid_return', 'Invalid synthetic native return.', 400);
        const assignmentId = fields.get('assignmentId')!;
        if (
          assignmentId &&
          ![...assignments.values()].some((row) => row.assignment.id === assignmentId)
        )
          return error('unknown_assignment', 'Unknown synthetic assignment.', 403);
        returns.push({ assignmentId, csrfToken: fields.get('csrfToken')! });
        state.returned = true;
        return {
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html lang="en"><title>Synthetic Canvas review</title><body><h1>Synthetic Canvas selection received</h1><p>This fixture is not a real Canvas publication.</p></body></html>',
        };
      }
      return error(
        'fixture_route_missing',
        'This route is not part of the synthetic fixture.',
        404,
      );
    },
  };
}
