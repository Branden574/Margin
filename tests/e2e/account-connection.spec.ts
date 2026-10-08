import { expect, test, type Page } from '@playwright/test';
import { unlockWorkspace } from './vault-helpers';

const ids = {
  session: '10000000-0000-4000-8000-000000000001',
  other: '10000000-0000-4000-8000-000000000002',
  user: '20000000-0000-4000-8000-000000000001',
  organization: '30000000-0000-4000-8000-000000000001',
};
async function install(
  page: Page,
  mode: 'lti-session' | 'oidc-session' | 'local-bearer',
  signedIn = false,
  emptyHealthOnce = false,
) {
  const calls: Array<{ path: string; method: string; csrf?: string }> = [];
  let current = signedIn,
    other = true;
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    calls.push({ path, method: req.method(), csrf: req.headers()['x-csrf-token'] });
    if (path === '/api/health' && emptyHealthOnce) {
      emptyHealthOnce = false;
      await route.fulfill({ status: 502, body: '' });
      return;
    }
    let status = 200,
      value: unknown;
    if (path === '/api/health') value = { authentication: mode };
    else if (path === '/api/auth/session' && current)
      value = {
        authenticated: true,
        authenticationMethod: mode === 'lti-session' ? 'lti' : 'oidc',
        sessionId: ids.session,
        userId: ids.user,
        organizationId: ids.organization,
        role: 'teacher',
        expiresAt: Date.now() + 3600000,
        csrfToken: 'a'.repeat(43),
      };
    else if (path === '/api/auth/session') {
      status = 401;
      value = { error: { code: 'session_expired' } };
    } else if (path === '/api/auth/sessions')
      value = {
        sessions: [ids.session, ...(other ? [ids.other] : [])].map((sessionId) => ({
          sessionId,
          organizationId: ids.organization,
          createdAt: Date.now() - 60000,
          expiresAt: Date.now() + 3600000,
          lastSeenAt: Date.now(),
          current: sessionId === ids.session,
        })),
      };
    else if (path === '/api/auth/sessions/' + ids.other && req.method() === 'DELETE') {
      other = false;
      value = { revoked: true };
    } else if (path === '/api/auth/logout' && req.method() === 'POST') {
      current = false;
      value = { signedOut: true };
    } else {
      status = 404;
      value = { error: { message: 'Synthetic route unavailable.' } };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  });
  return calls;
}
async function open(page: Page) {
  await page.goto('/#settings');
  await unlockWorkspace(page);
  await expect(page.getByRole('heading', { name: 'Organization account' })).toBeVisible();
  await page.getByRole('button', { name: 'Check account connection' }).click();
  await expect(page.getByRole('button', { name: 'Check account connection' })).toBeEnabled();
}
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('LTI account retains authenticated session controls and CSRF mutations without an OIDC form', async ({
  page,
}) => {
  const calls = await install(page, 'lti-session', true);
  await open(page);
  await expect(page.getByText('Signed in through Canvas · teacher', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Active sessions' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with your organization' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoke session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revoke session', exact: true })).toHaveCount(0);
  expect(calls).toContainEqual({
    path: '/api/auth/sessions/' + ids.other,
    method: 'DELETE',
    csrf: 'a'.repeat(43),
  });
  await page.getByRole('button', { name: 'Sign out and lock workspace' }).click();
  await expect(page.getByRole('button', { name: 'Unlock workspace' })).toBeVisible();
  expect(calls).toContainEqual({ path: '/api/auth/logout', method: 'POST', csrf: 'a'.repeat(43) });
  expect(calls.some((call) => call.path === '/api/auth/login')).toBe(false);
});

test('an empty account response can be retried before LTI launch guidance without OIDC sign-in', async ({
  page,
}) => {
  const calls = await install(page, 'lti-session', false, true);
  await open(page);
  await expect(page.getByRole('alert')).toHaveText(
    'The account service is temporarily unavailable. Try checking the connection again.',
  );
  await page.getByRole('button', { name: 'Check account connection' }).click();
  await expect(page.getByRole('button', { name: 'Check account connection' })).toBeEnabled();
  await expect(
    page.getByText(
      'Open an assignment from its Canvas activity to connect your organization account.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in with your organization' })).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Organization ID (if supplied by your administrator)' }),
  ).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Active sessions' })).toHaveCount(0);
  expect(calls.map((call) => call.path)).toEqual([
    '/api/health',
    '/api/health',
    '/api/auth/session',
  ]);
});

test('OIDC and local account connection modes keep their existing entry points', async ({
  page,
}) => {
  await install(page, 'oidc-session');
  await open(page);
  await expect(page.getByRole('button', { name: 'Sign in with your organization' })).toBeVisible();
  await expect(
    page.getByText(
      'Open an assignment from its Canvas activity to connect your organization account.',
    ),
  ).toHaveCount(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await install(page, 'local-bearer');
  await page.getByRole('button', { name: 'Check account connection' }).click();
  await expect(
    page.getByText(
      'Organization sign-in is not configured on this server. Your local workspace remains available.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with your organization' })).toHaveCount(0);
});
