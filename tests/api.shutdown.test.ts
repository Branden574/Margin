import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { createApi } from '../apps/api/src/server';
import type { IdentityService } from '../apps/api/src/identity';

it('drains route work after its client disconnects before declaring dependencies safe to close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'margin-drain-'));
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let completed = false;
  const identity = {
    applicationOrigin: 'https://127.0.0.1:5174',
    authenticationMode: 'lti-only',
    async authenticateRequest() {
      enter();
      await pending;
      completed = true;
      throw new Error('Synthetic delayed authority failure.');
    },
  } as unknown as IdentityService;
  const server = createApi({
    dataDirectory: directory,
    identityService: identity,
    keyEncryptionKey: Buffer.alloc(32, 71),
    allowInsecureTestTransport: true,
    logger: () => {},
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = get(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/api/documents`,
    );
    const disconnected = new Promise<void>((resolve) => {
      client.once('error', () => resolve());
    });
    await entered;
    client.destroy();
    await disconnected;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    let drained = false;
    const draining = server.drainRequests().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(drained).toBe(false);
    finish();
    await draining;
    expect(completed).toBe(true);
    await server.drainRequests();
  } finally {
    finish();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await server.drainRequests();
    await rm(directory, { recursive: true, force: true });
  }
});
