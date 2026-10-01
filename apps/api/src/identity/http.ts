import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { clearLoginCookie, type IdentityService } from './service.js';
import { IdentityError } from './types.js';

/** Install once per server. Public admission limits bound local memory; add shared edge limits before scale-out. */
export function createIdentityHandler(service: IdentityService) {
  const windows = new Map<string, { at: number; count: number }>();
  let active = 0;
  return async function handleIdentityRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (!req.url?.startsWith('/api/auth/') || req.url.startsWith('//')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    let admitted = false;
    let callback = false;
    try {
      if (!(req.socket as TLSSocket).encrypted)
        throw new IdentityError(400, 'https_required', 'HTTPS is required for sign-in.');
      if (req.url.length > 8192)
        throw new IdentityError(414, 'request_too_large', 'The sign-in request is too large.');
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0)
        throw new IdentityError(
          400,
          'body_not_allowed',
          'Authentication routes do not accept request bodies.',
        );
      const now = Date.now();
      for (const [key, value] of windows) if (now - value.at >= 60000) windows.delete(key);
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (!windows.has(ip) && windows.size >= 4096)
        throw new IdentityError(503, 'identity_busy', 'Sign-in is busy. Retry shortly.');
      const window = windows.get(ip) ?? { at: now, count: 0 };
      windows.set(ip, window);
      if (++window.count > 120 || active >= 16)
        throw new IdentityError(
          429,
          'identity_rate_limited',
          'Too many sign-in requests. Retry shortly.',
        );
      active++;
      admitted = true;
      const url = new URL(req.url, service.applicationOrigin);
      if (url.origin !== service.applicationOrigin)
        throw new IdentityError(400, 'invalid_url', 'Invalid sign-in request.');
      callback = url.pathname === service.callbackPath;
      if (!callback) service.requireSameOrigin(req, req.method !== 'GET');
      if (req.method === 'GET' && url.pathname === '/api/auth/login') {
        const allowed = new Set(['returnTo', 'organizationId']);
        for (const key of url.searchParams.keys())
          if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
            throw new IdentityError(
              400,
              'invalid_login_parameters',
              'The sign-in parameters are invalid.',
            );
        const result = await service.startLogin({
          returnTo: url.searchParams.get('returnTo') ?? undefined,
          organizationId: url.searchParams.get('organizationId') ?? undefined,
        });
        res.setHeader('Set-Cookie', result.cookies);
        res.writeHead(302, { Location: result.location });
        res.end();
      } else if (req.method === 'GET' && callback) {
        const result = await service.completeLogin(url, req.headers.cookie);
        res.setHeader('Set-Cookie', result.cookies);
        res.writeHead(302, { Location: result.location });
        res.end();
      } else if (req.method === 'GET' && url.pathname === '/api/auth/session' && !url.search) {
        const { principal, csrfToken } = await service.authenticateRequest(req);
        send(200, { authenticated: true, ...principal, csrfToken });
      } else if (req.method === 'POST' && url.pathname === '/api/auth/logout' && !url.search) {
        res.setHeader('Set-Cookie', await service.logoutRequest(req));
        send(200, { signedOut: true });
      } else if (req.method === 'GET' && url.pathname === '/api/auth/sessions' && !url.search) {
        send(200, { sessions: await service.listSessions(req) });
      } else if (
        req.method === 'DELETE' &&
        /^\/api\/auth\/sessions\/[^/]+$/.test(url.pathname) &&
        !url.search
      ) {
        if (!(await service.revokeOwnedSession(req, url.pathname.split('/').at(-1)!)))
          throw new IdentityError(
            404,
            'session_not_found',
            'This session is unavailable to your account.',
          );
        send(200, { revoked: true });
      } else
        throw new IdentityError(
          404,
          'auth_route_not_found',
          'This authentication route is unavailable.',
        );
    } catch (error) {
      if (callback) res.setHeader('Set-Cookie', clearLoginCookie());
      const known = error instanceof IdentityError;
      if (known && [429, 503].includes(error.status)) res.setHeader('Retry-After', '30');
      send(known ? error.status : 503, {
        error: {
          code: known ? error.code : 'identity_unavailable',
          message: known
            ? error.message
            : 'Sign-in is temporarily unavailable. Retry shortly; local work is unchanged.',
        },
      });
    } finally {
      if (admitted) active--;
    }
    return true;
  };
}
