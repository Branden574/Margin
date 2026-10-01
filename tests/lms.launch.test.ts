import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import {
  AGS_CLAIM,
  CANVAS_SCOPES,
  CanvasLMSProvider,
  DEEP_LINK_CLAIM,
  hostedCanvasEndpoints,
  LTI_CLAIM,
  LTIError,
  NRPS_CLAIM,
  type CanvasInstallation,
  type LaunchAttempt,
  type LaunchReplayRepository,
  type LoginRedirect,
} from '../packages/lms/src/index';

const at = Date.UTC(2026, 9, 1, 12),
  origin = 'https://school.instructure.com';
const target = 'https://margin.example/lti/launch',
  deepTarget = 'https://margin.example/lti/select';
const role = (name: string) => `http://purl.imsglobal.org/vocab/lis/v2/membership#${name}`;
let fixtureJwks: { keys: import('jose').JWK[] };
let privateKey: CryptoKey, otherPrivate: CryptoKey, keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherPrivate = (await generateKeyPair('RS256')).privateKey;
  fixtureJwks = {
    keys: [
      { ...(await exportJWK(pair.publicKey)), kid: 'canvas-fixture-key', alg: 'RS256', use: 'sig' },
    ],
  };
  keys = createLocalJWKSet(fixtureJwks);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
/** Synthetic fixture only; production must implement these atomic operations durably. */
class FixtureReplayStore implements LaunchReplayRepository {
  attempts = new Map<string, LaunchAttempt>();
  nonces = new Map<string, number>();
  async create(attempt: LaunchAttempt) {
    if (this.attempts.has(attempt.stateDigest)) return false;
    this.attempts.set(attempt.stateDigest, structuredClone(attempt));
    return true;
  }
  async find(stateDigest: string) {
    const value = this.attempts.get(stateDigest);
    return value ? structuredClone(value) : null;
  }
  async consume(attempt: LaunchAttempt, now: number, retainUntil: number) {
    const saved = this.attempts.get(attempt.stateDigest),
      key = attempt.installationId + ':' + attempt.nonceDigest;
    if (
      !saved ||
      saved.expiresAt <= now ||
      JSON.stringify(saved) !== JSON.stringify(attempt) ||
      (this.nonces.get(key) ?? 0) > now
    )
      return false;
    this.attempts.delete(attempt.stateDigest);
    this.nonces.set(key, retainUntil);
    return true;
  }
}
function setup(authorized = false, remoteKeys = false) {
  let now = at;
  const installation: CanvasInstallation = {
    id: 'installation-1',
    organizationId: 'organization-school-a',
    version: 1,
    enabled: true,
    ...hostedCanvasEndpoints('production'),
    clientId: 'client-123',
    deploymentId: 'deployment-school-a',
    targets: [
      { uri: target, messageType: 'LtiResourceLinkRequest' },
      { uri: deepTarget, messageType: 'LtiDeepLinkingRequest' },
    ],
    serviceOrigins: [origin],
    allowedServiceScopes: Object.values(CANVAS_SCOPES),
  };
  const replay = new FixtureReplayStore();
  const provider = new CanvasLMSProvider({
    installations: {
      findById: async (id) => (id === installation.id ? structuredClone(installation) : null),
    },
    replay,
    ...(remoteKeys ? {} : { resolveKey: () => keys }),
    now: () => now,
    ...(authorized ? { authorizeService: async () => true } : {}),
  });
  const begin = async (uri = target) =>
    provider.beginLogin(installation.id, {
      iss: installation.issuer,
      client_id: installation.clientId,
      deployment_id: installation.deploymentId,
      login_hint: 'opaque-login-hint',
      lti_message_hint: 'opaque-message-hint',
      target_link_uri: uri,
    });
  const token = async (
    login: LoginRedirect,
    patch: Record<string, unknown> = {},
    key = privateKey,
    header: Record<string, unknown> = {},
  ) =>
    new SignJWT({
      iss: installation.issuer,
      aud: installation.clientId,
      sub: 'canvas-pairwise-user',
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 240,
      nonce: new URL(login.authorizationUrl).searchParams.get('nonce'),
      [LTI_CLAIM + 'version']: '1.3.0',
      [LTI_CLAIM + 'deployment_id']: installation.deploymentId,
      [LTI_CLAIM + 'message_type']: 'LtiResourceLinkRequest',
      [LTI_CLAIM + 'target_link_uri']: target,
      [LTI_CLAIM + 'roles']: [role('Learner')],
      [LTI_CLAIM + 'resource_link']: { id: 'external-assignment', title: 'Biology' },
      [LTI_CLAIM + 'context']: { id: 'external-course', title: 'Biology class' },
      ...patch,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'canvas-fixture-key', ...header })
      .sign(key);
  const launch = async (login: LoginRedirect, patch: Record<string, unknown> = {}) =>
    provider.validateLaunch({
      state: login.state,
      browserBinding: login.browserBinding,
      id_token: await token(login, patch),
    });
  return {
    provider,
    installation,
    replay,
    begin,
    token,
    launch,
    setNow: (next: number) => {
      now = next;
    },
  };
}

describe('Canvas LTI 1.3 launch foundation with signed synthetic JWTs', () => {
  it('bounds the registered JWKS cache with eviction and requires verified, redirect-free HTTPS fetching', async () => {
    const calls: string[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push(String(url));
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify(fixtureJwks), {
        headers: { 'content-type': 'application/jwk-set+json' },
      });
    });
    const f = setup(false, true);
    for (let i = 0; i < 129; i++) {
      f.installation.jwksUri = `https://registered-keys.test/${i}`;
      await f.launch(await f.begin());
    }
    expect(fetch).toHaveBeenCalledTimes(129);
    f.installation.jwksUri = 'https://registered-keys.test/128';
    await f.launch(await f.begin());
    expect(fetch).toHaveBeenCalledTimes(129);
    f.installation.jwksUri = 'https://registered-keys.test/0';
    await f.launch(await f.begin());
    expect(fetch).toHaveBeenCalledTimes(130);
    expect(calls.every((url) => url.startsWith('https://registered-keys.test/'))).toBe(true);
  });
  it.each(['declared-size', 'stream-size', 'content-type', 'status', 'too-many-keys'] as const)(
    'rejects a %s JWKS response',
    async (kind) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        if (kind === 'declared-size')
          return new Response('{}', {
            headers: { 'content-type': 'application/json', 'content-length': '131073' },
          });
        if (kind === 'stream-size')
          return new Response(' '.repeat(131073), {
            headers: { 'content-type': 'application/json' },
          });
        if (kind === 'content-type')
          return new Response(JSON.stringify(fixtureJwks), {
            headers: { 'content-type': 'text/html' },
          });
        if (kind === 'status')
          return new Response('', {
            status: 302,
            headers: {
              location: 'https://unapproved.test/keys',
              'content-type': 'application/json',
            },
          });
        return new Response(
          JSON.stringify({ keys: Array.from({ length: 65 }, () => fixtureJwks.keys[0]) }),
          { headers: { 'content-type': 'application/json' } },
        );
      });
      const f = setup(false, true);
      await expect(f.launch(await f.begin())).rejects.toMatchObject({ code: 'token' });
    },
  );
  it('refuses globally disabled TLS verification', () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    expect(() => setup()).toThrow('TLS');
  });

  it('preserves empty opaque Deep Linking data exactly after signed validation', async () => {
    const f = setup(),
      flow = await f.begin(deepTarget);
    const result = await f.launch(flow, {
      [LTI_CLAIM + 'message_type']: 'LtiDeepLinkingRequest',
      [LTI_CLAIM + 'target_link_uri']: deepTarget,
      [DEEP_LINK_CLAIM]: {
        deep_link_return_url: origin + '/return',
        accept_types: ['ltiResourceLink'],
        accept_presentation_document_targets: ['window'],
        data: '',
      },
    });
    expect(result.deepLinking?.data).toBe('');
  });
  it('exposes only the validated signed assignment custom identifier', async () => {
    const f = setup(),
      id = 'e044a63d-e4df-419e-9a32-447ec3d465ab';
    const result = await f.launch(await f.begin(), {
      [LTI_CLAIM + 'custom']: { margin_assignment_id: id, other: 'ignored' },
    });
    expect(result.resource?.assignmentId).toBe(id);
    expect(result).not.toHaveProperty('custom');
  });
  it.each(['not-a-uuid', 'https://unapproved.test', 42])(
    'rejects invalid signed assignment custom value %s',
    async (value) => {
      const f = setup();
      await expect(
        f.launch(await f.begin(), { [LTI_CLAIM + 'custom']: { margin_assignment_id: value } }),
      ).rejects.toMatchObject({ code: 'context' });
    },
  );
  it('pins hosted environments to official issuer/authorization/JWKS tuples', () => {
    expect(hostedCanvasEndpoints('production')).toEqual({
      issuer: 'https://canvas.instructure.com',
      authorizationEndpoint: 'https://sso.canvaslms.com/api/lti/authorize_redirect',
      jwksUri: 'https://sso.canvaslms.com/api/lti/security/jwks',
    });
    expect(hostedCanvasEndpoints('beta').jwksUri).toContain('sso.beta.canvaslms.com');
    expect(hostedCanvasEndpoints('test').issuer).toBe('https://canvas.test.instructure.com');
  });
  it('creates an independent browser binding and hashes persisted flow secrets', async () => {
    const f = setup(),
      login = await f.begin(),
      url = new URL(login.authorizationUrl);
    expect(url.searchParams.get('response_type')).toBe('id_token');
    expect(url.searchParams.get('response_mode')).toBe('form_post');
    expect(url.searchParams.get('prompt')).toBe('none');
    expect(url.searchParams.get('lti_message_hint')).toBe('opaque-message-hint');
    expect(url.searchParams.get('login_hint')).toBe('opaque-login-hint');
    expect(login.browserBinding).not.toBe(login.state);
    expect(login.authorizationUrl).not.toContain(login.browserBinding);
    const stored = JSON.stringify([...f.replay.attempts.values()]);
    expect(stored).not.toContain(login.state);
    expect(stored).not.toContain(login.browserBinding);
    expect(stored).not.toContain(url.searchParams.get('nonce'));
  });
  it.each([
    ['Learner', 'learner'],
    ['Instructor', 'instructor'],
    ['Administrator', 'administrator'],
  ])('normalizes verified %s role as a hint, without issuing a session', async (protocol, hint) => {
    const f = setup(),
      context = await f.launch(await f.begin(), {
        [LTI_CLAIM + 'roles']: [role(protocol)],
        email: 'not-retained@example.invalid',
        organizationId: 'attacker-org',
      });
    expect(context.user.roleHints).toEqual([hint]);
    expect(context.organizationId).toBe('organization-school-a');
    expect(context.course?.reference.externalId).toBe('external-course');
    expect(context.user.reference.installationId).toBe('installation-1');
    expect('email' in context.user).toBe(false);
    expect('sessionId' in context).toBe(false);
    expect(Object.isFrozen(context.services)).toBe(true);
  });
  it('does not elevate lookalike or unrelated role values', async () => {
    const f = setup(),
      context = await f.launch(await f.begin(), {
        [LTI_CLAIM + 'roles']: [
          'Administrator',
          'https://attacker.invalid/Instructor',
          'http://purl.imsglobal.org/vocab/lis/v2/membership/Instructor#TeachingAssistant',
        ],
      });
    expect(context.user.roleHints).toEqual([]);
  });
  it.each([
    ['issuer', { iss: 'https://canvas.beta.instructure.com' }],
    ['audience', { aud: 'different-client' }],
    ['additional audience', { aud: ['client-123', 'untrusted-client'], azp: 'client-123' }],
    ['authorized party', { azp: 'different-client' }],
    ['expiration', { exp: at / 1000 - 60 }],
    ['future issued-at', { iat: at / 1000 + 120 }],
    ['old issued-at', { iat: at / 1000 - 400 }],
    ['excessive lifetime', { exp: at / 1000 + 3600 }],
    ['nonce', { nonce: 'substituted-nonce' }],
    ['deployment', { [LTI_CLAIM + 'deployment_id']: 'another-school-deployment' }],
    ['message type', { [LTI_CLAIM + 'message_type']: 'LtiDeepLinkingRequest' }],
    ['version', { [LTI_CLAIM + 'version']: '1.1.0' }],
    ['target URI', { [LTI_CLAIM + 'target_link_uri']: 'https://attacker.invalid/launch' }],
    ['roles shape', { [LTI_CLAIM + 'roles']: 'Instructor' }],
    ['missing resource', { [LTI_CLAIM + 'resource_link']: undefined }],
    ['missing subject', { sub: undefined }],
  ])('rejects invalid %s', async (_name, patch) => {
    const f = setup(),
      login = await f.begin();
    await expect(f.launch(login, patch)).rejects.toBeInstanceOf(LTIError);
  });
  it('requires azp for explicitly trusted multiple audiences', async () => {
    const f = setup();
    f.installation.trustedAdditionalAudiences = ['trusted-client'];
    const login = await f.begin();
    await expect(f.launch(login, { aud: ['client-123', 'trusted-client'] })).rejects.toThrow(
      'audience',
    );
    expect(
      (await f.launch(login, { aud: ['client-123', 'trusted-client'], azp: 'client-123' }))
        .clientId,
    ).toBe('client-123');
  });
  it('rejects an otherwise valid launch signed with the wrong key', async () => {
    const f = setup(),
      login = await f.begin();
    await expect(
      f.provider.validateLaunch({ ...login, id_token: await f.token(login, {}, otherPrivate) }),
    ).rejects.toThrow('signature');
  });
  it('does not accept token-supplied key locations', async () => {
    const f = setup(),
      login = await f.begin();
    await expect(
      f.provider.validateLaunch({
        ...login,
        id_token: await f.token(login, {}, privateKey, { jku: 'https://attacker.invalid/keys' }),
      }),
    ).rejects.toThrow('signature');
  });
  it('rejects missing or swapped independent browser binding', async () => {
    const f = setup(),
      login = await f.begin(),
      other = await f.begin();
    await expect(
      f.provider.validateLaunch({ ...login, browserBinding: '', id_token: await f.token(login) }),
    ).rejects.toThrow('browser');
    await expect(
      f.provider.validateLaunch({
        ...login,
        browserBinding: other.browserBinding,
        id_token: await f.token(login),
      }),
    ).rejects.toThrow('browser');
    await expect(f.launch(login)).resolves.toMatchObject({ provider: 'canvas' });
  });
  it('allows exactly one simultaneous consumption of a state/nonce', async () => {
    const f = setup(),
      login = await f.begin(),
      input = { ...login, id_token: await f.token(login) };
    const results = await Promise.allSettled([
      f.provider.validateLaunch(input),
      f.provider.validateLaunch(input),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(f.provider.validateLaunch(input)).rejects.toBeInstanceOf(LTIError);
  });
  it('expires attempts and rejects registration changes or revocation', async () => {
    const expired = setup(),
      login = await expired.begin();
    expired.setNow(at + 300_001);
    await expect(expired.launch(login)).rejects.toThrow('expired');
    const changed = setup(),
      second = await changed.begin();
    changed.installation.version++;
    await expect(changed.launch(second)).rejects.toThrow('configuration changed');
    const revoked = setup(),
      third = await revoked.begin();
    revoked.installation.enabled = false;
    await expect(revoked.launch(third)).rejects.toThrow('revoked');
  });
  it('rejects unknown installations, target redirects and cross-environment login hints', async () => {
    const f = setup(),
      base = { iss: f.installation.issuer, login_hint: 'hint', target_link_uri: target };
    await expect(f.provider.beginLogin('unknown', base)).rejects.toThrow('unavailable');
    await expect(
      f.provider.beginLogin(f.installation.id, {
        ...base,
        target_link_uri: 'https://attacker.invalid',
      }),
    ).rejects.toThrow('not registered');
    await expect(
      f.provider.beginLogin(f.installation.id, {
        ...base,
        iss: hostedCanvasEndpoints('test').issuer,
      }),
    ).rejects.toThrow('registered installation');
    await expect(
      f.provider.beginLogin(f.installation.id, { ...base, lti_deployment_id: 'wrong-school' }),
    ).rejects.toThrow('registered installation');
  });
  it('validates Deep Linking launch context without claiming a Deep Linking response exists', async () => {
    const f = setup(),
      login = await f.begin(deepTarget),
      context = await f.launch(login, {
        [LTI_CLAIM + 'message_type']: 'LtiDeepLinkingRequest',
        [LTI_CLAIM + 'target_link_uri']: deepTarget,
        [LTI_CLAIM + 'resource_link']: undefined,
        [DEEP_LINK_CLAIM]: {
          deep_link_return_url: origin + '/courses/123/deep_link_return',
          accept_types: ['ltiResourceLink'],
          accept_presentation_document_targets: ['window'],
          data: 'opaque-return-data',
        },
      });
    expect(context.deepLinking?.data).toBe('opaque-return-data');
    expect(context.resource).toBeUndefined();
    expect(f.provider.capabilities).toEqual(['lti-launch-verification']);
  });
});

describe('AGS and NRPS authorization preparation boundaries', () => {
  const serviceClaims = {
    [AGS_CLAIM]: {
      lineitem: origin + '/api/lti/courses/123/line_items/45?tag=biology',
      lineitems: origin + '/api/lti/courses/123/line_items',
      scope: [CANVAS_SCOPES.score, CANVAS_SCOPES.lineItemsRead],
    },
    [NRPS_CLAIM]: {
      context_memberships_url: origin + '/api/lti/courses/123/names_and_roles',
      service_versions: ['2.0'],
    },
  };
  it('denies by default even when a signed launch includes service scopes', async () => {
    const f = setup(),
      context = await f.launch(await f.begin(), serviceClaims);
    await expect(f.provider.prepareServiceRequest(context, 'read-roster')).rejects.toThrow(
      'not authorized',
    );
    await expect(f.provider.prepareServiceRequest(context, 'write-score')).rejects.toThrow(
      'not authorized',
    );
  });
  it('prepares only the least necessary scoped descriptor after application authorization', async () => {
    const f = setup(true),
      context = await f.launch(await f.begin(), serviceClaims);
    expect(await f.provider.prepareServiceRequest(context, 'read-roster')).toMatchObject({
      method: 'GET',
      scopes: [CANVAS_SCOPES.roster],
    });
    expect(await f.provider.prepareServiceRequest(context, 'write-score')).toMatchObject({
      method: 'POST',
      url: origin + '/api/lti/courses/123/line_items/45/scores?tag=biology',
      scopes: [CANVAS_SCOPES.score],
    });
    expect(await f.provider.prepareServiceRequest(context, 'read-line-items')).toMatchObject({
      scopes: [CANVAS_SCOPES.lineItemsRead],
    });
  });
  it('rejects forged context, expired context and revoked installations', async () => {
    const f = setup(true),
      context = await f.launch(await f.begin(), serviceClaims);
    await expect(
      f.provider.prepareServiceRequest(structuredClone(context), 'read-roster'),
    ).rejects.toThrow('verified launch');
    f.installation.enabled = false;
    await expect(f.provider.prepareServiceRequest(context, 'read-roster')).rejects.toThrow(
      'revoked',
    );
    f.installation.enabled = true;
    f.setNow(at + 241_000);
    await expect(f.provider.prepareServiceRequest(context, 'read-roster')).rejects.toThrow(
      'verified launch',
    );
  });
  it('never elevates the installation scope ceiling from signed claims', async () => {
    const f = setup(true);
    f.installation.allowedServiceScopes = [];
    const context = await f.launch(await f.begin(), serviceClaims);
    expect(context.services.grades?.scopes).toEqual([]);
    await expect(f.provider.prepareServiceRequest(context, 'write-score')).rejects.toThrow('scope');
    await expect(f.provider.prepareServiceRequest(context, 'read-roster')).rejects.toThrow(
      'not granted',
    );
  });
  it.each([
    'https://attacker.invalid/members',
    'http://school.instructure.com/members',
    'https://school.instructure.com@attacker.invalid/members',
    'https://school.instructure.com/members#fragment',
  ])('rejects signed unsafe service endpoint %s', async (url) => {
    const f = setup();
    await expect(
      f.launch(await f.begin(), {
        [NRPS_CLAIM]: { context_memberships_url: url, service_versions: ['2.0'] },
      }),
    ).rejects.toBeInstanceOf(LTIError);
  });
  it('rejects nonce reuse even with a second otherwise matching persisted state', async () => {
    const f = setup(),
      first = await f.begin(),
      firstToken = await f.token(first),
      nonce = new URL(first.authorizationUrl).searchParams.get('nonce')!;
    await f.provider.validateLaunch({ ...first, id_token: firstToken });
    const second = await f.begin(),
      entry = [...f.replay.attempts.values()][0];
    entry.nonceDigest = createHash('sha256').update(nonce).digest('hex');
    await expect(f.launch(second, { nonce })).rejects.toThrow('already been used');
  });
});
