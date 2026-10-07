import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { PostgresAssignmentSubmissionService } from '../apps/api/src/assignments/submissions';
import { WorkAuthority } from '../apps/api/src/assignments/work/authority';
import { LocalKeyProvider } from '../apps/api/src/encryption';
import { AssignmentError } from '../apps/api/src/assignments/types';
import type { SessionPrincipal } from '../apps/api/src/identity/types';
const principal = {
  sessionId: randomUUID(),
  organizationId: randomUUID(),
  userId: randomUUID(),
  role: 'student',
  authenticationMethod: 'lti',
  mfa: false,
  createdAt: 0,
  lastSeenAt: 0,
  expiresAt: Date.now() + 60000,
} satisfies SessionPrincipal;
const make = () =>
  new PostgresAssignmentSubmissionService(
    { host: '/synthetic-unused-socket', user: 'unused' },
    new LocalKeyProvider(randomBytes(32)),
    { captureEnabled: true },
  );
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('submission capture action bounds', () => {
  it('holds both admission slots until timed-out underlying work settles, withholding every late result', async () => {
    vi.useFakeTimers();
    const rejectors: Array<(e: unknown) => void> = [];
    vi.spyOn(WorkAuthority.prototype, 'prepare').mockImplementation(
      () => new Promise((_, reject) => rejectors.push(reject)),
    );
    const service = make();
    try {
      const one = service.capture(principal, { requestId: randomUUID(), expectedCursor: 0 }),
        two = service.capture(principal, { requestId: randomUUID(), expectedCursor: 0 });
      const denied = Promise.all([
        expect(one).rejects.toMatchObject({ code: 'submission_unavailable' }),
        expect(two).rejects.toMatchObject({ code: 'submission_unavailable' }),
      ]);
      await vi.advanceTimersByTimeAsync(25000);
      await denied;
      await expect(service.list(principal, {})).rejects.toMatchObject({ code: 'submission_busy' });
      for (const reject of rejectors) reject(new Error('late provider rejection'));
      await vi.advanceTimersByTimeAsync(0);
      vi.spyOn(WorkAuthority.prototype, 'prepare').mockRejectedValue(
        new AssignmentError(403, 'fresh_authority_required', 'Launch again.'),
      );
      await expect(service.list(principal, {})).rejects.toMatchObject({
        code: 'fresh_authority_required',
      });
    } finally {
      await service.close();
    }
  });
  it('does not consume admission or call authority for already-aborted requests', async () => {
    const prepare = vi.spyOn(WorkAuthority.prototype, 'prepare'),
      service = make(),
      controller = new AbortController();
    controller.abort();
    try {
      for (let i = 0; i < 3; i++)
        await expect(
          service.list(principal, {}, { signal: controller.signal }),
        ).rejects.toMatchObject({ code: 'submission_unavailable' });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });
  it('rejects noncanonical UUIDs before database/encryption work', async () => {
    const prepare = vi.spyOn(WorkAuthority.prototype, 'prepare'),
      service = make(),
      requestId = randomUUID().toUpperCase();
    try {
      await expect(
        service.capture(principal, { requestId, expectedCursor: 0 }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(service.request(principal, requestId)).rejects.toMatchObject({ status: 400 });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });
});
