import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { LTIError, type LoginInitiation } from '@margin/lms';
import { clearLaunchCookie, type LmsService } from './service.js';
import { LmsHttpError } from './types.js';
import { IdentityError } from '../identity/types.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const loginKeys = new Set([
  'iss',
  'login_hint',
  'target_link_uri',
  'client_id',
  'lti_message_hint',
  'lti_deployment_id',
  'deployment_id',
]);
const launchKeys = new Set(['state', 'id_token', 'error', 'error_description']);
function validateParameters(params: URLSearchParams, allowed: Set<string>) {
  for (const [key, value] of params)
    if (
      !allowed.has(key) ||
      params.getAll(key).length !== 1 ||
      value.length > (key === 'id_token' ? 65536 : 4096) ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw new LmsHttpError(
        400,
        'invalid_parameters',
        'The Canvas request parameters are invalid.',
      );
}
async function form(req: IncomingMessage): Promise<URLSearchParams> {
  if (
    req.headers['content-type']?.split(';')[0].trim().toLowerCase() !==
      'application/x-www-form-urlencoded' ||
    req.headers['content-encoding']
  )
    throw new LmsHttpError(
      415,
      'form_required',
      'Canvas launch requires an uncompressed form response.',
    );
  const length = Number(req.headers['content-length']);
  if (
    req.headers['content-length'] !== undefined &&
    (!Number.isSafeInteger(length) || length < 0 || length > 98304)
  )
    throw new LmsHttpError(413, 'body_too_large', 'The Canvas request is too large.');
  return await new Promise((resolve, reject) => {
    let bytes = 0,
      done = false;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAbort);
      req.off('error', onError);
      if (error) {
        req.resume();
        reject(error);
      } else resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 98304)
        finish(new LmsHttpError(413, 'body_too_large', 'The Canvas request is too large.'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAbort = () =>
      finish(new LmsHttpError(400, 'request_aborted', 'The Canvas request was interrupted.'));
    const onError = () =>
      finish(new LmsHttpError(400, 'request_failed', 'The Canvas request failed.'));
    const timer = setTimeout(
      () => finish(new LmsHttpError(408, 'request_timeout', 'The Canvas request took too long.')),
      5000,
    );
    timer.unref();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAbort);
    req.on('error', onError);
  });
}
/** Install once. Only the continuation response has a narrowly registered frame allowlist. */
export function createLmsHandler(service: LmsService) {
  const windows = new Map<string, { at: number; count: number }>();
  let active = 0;
  return async function handleLmsRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (!req.url?.startsWith('/api/lms/') || req.url.startsWith('//')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    );
    res.setHeader('X-Frame-Options', 'DENY');
    let admitted = false;
    let state: string | undefined;
    try {
      if (!(req.socket as TLSSocket).encrypted)
        throw new LmsHttpError(400, 'https_required', 'HTTPS is required for Canvas launch.');
      if (req.url.length > 16384)
        throw new LmsHttpError(414, 'request_too_large', 'The Canvas request is too large.');
      const now = Date.now();
      for (const [ip, window] of windows) if (now - window.at >= 60000) windows.delete(ip);
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (!windows.has(ip) && windows.size >= 4096)
        throw new LmsHttpError(503, 'lms_busy', 'Canvas sign-in is busy. Retry shortly.');
      const window = windows.get(ip) ?? { at: now, count: 0 };
      windows.set(ip, window);
      if (++window.count > 120 || active >= 16)
        throw new LmsHttpError(
          429,
          'lms_rate_limited',
          'Too many Canvas launch requests. Retry shortly.',
        );
      admitted = true;
      active++;
      const url = new URL(req.url, service.applicationOrigin);
      if (url.origin === service.applicationOrigin && url.pathname === '/api/lms/context') {
        if (
          req.method !== 'GET' ||
          url.search ||
          req.headers['transfer-encoding'] ||
          Number(req.headers['content-length'] ?? 0) > 0
        )
          throw new LmsHttpError(
            400,
            'invalid_context_request',
            'Canvas context requires a bodyless GET request.',
          );
        const value = await service.context(req);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
        return true;
      }
      const match = url.pathname.match(/^\/api\/lms\/canvas\/([^/]+)\/(login|launch|deep-link)$/);
      if (url.origin !== service.applicationOrigin || !match || !uuid.test(match[1]))
        throw new LmsHttpError(404, 'lms_route_not_found', 'This Canvas route is unavailable.');
      const [, id, operation] = match;
      if (
        (operation === 'login' && !['GET', 'POST'].includes(req.method ?? '')) ||
        (operation !== 'login' && req.method !== 'POST')
      )
        throw new LmsHttpError(
          405,
          'method_not_allowed',
          'This Canvas request method is not supported.',
        );
      if (req.method === 'POST' && url.search)
        throw new LmsHttpError(
          400,
          'query_not_allowed',
          'Canvas form requests cannot also contain query parameters.',
        );
      if (
        req.method === 'GET' &&
        (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0)
      )
        throw new LmsHttpError(
          400,
          'body_not_allowed',
          'Canvas GET requests cannot contain a body.',
        );
      const parameters = req.method === 'POST' ? await form(req) : url.searchParams;
      validateParameters(parameters, operation === 'login' ? loginKeys : launchKeys);
      if (operation === 'login') {
        const registration = await service.installation(id);
        if (
          req.headers['sec-fetch-dest'] === 'iframe' ||
          req.headers['sec-fetch-dest'] === 'frame'
        ) {
          // A user gesture restarts initiation top-level before creating the independent binding cookie.
          if (!registration.frameOrigins.length)
            throw new LmsHttpError(
              403,
              'top_level_required',
              'Open Margin from Canvas in a top-level tab to continue.',
            );
          res.removeHeader('X-Frame-Options');
          res.setHeader(
            'Content-Security-Policy',
            `default-src 'none'; frame-ancestors ${registration.frameOrigins.join(' ')}; form-action 'self'; base-uri 'none'`,
          );
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Continue to Margin</title><body><main><h1>Continue to Margin</h1><p>Open this secure launch in the main browser tab. Margin does not bypass your browser’s cookie protection.</p><form method="post" target="_top" action="${escape(url.pathname)}">${[...parameters].map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join('')}<button type="submit">Continue in this tab</button></form></main></body></html>`,
          );
          return true;
        }
        const result = await service.beginLogin(
          id,
          Object.fromEntries(parameters) as unknown as LoginInitiation,
          req.headers.cookie,
        );
        res.setHeader('Set-Cookie', result.cookies);
        res.writeHead(302, { Location: result.location });
        res.end();
      } else {
        state = parameters.get('state') ?? undefined;
        if (req.headers['sec-fetch-dest'] === 'iframe' || req.headers['sec-fetch-dest'] === 'frame')
          throw new LmsHttpError(
            403,
            'top_level_required',
            'Return to Canvas and use the top-level Margin launch to continue.',
          );
        const result = await service.completeLaunch(id, url.pathname, parameters, req);
        res.setHeader('Set-Cookie', result.cookies);
        res.writeHead(303, { Location: result.location });
        res.end();
      }
    } catch (error) {
      if (state && /^[A-Za-z0-9_-]{43}$/.test(state))
        res.setHeader('Set-Cookie', clearLaunchCookie(state));
      const known = error instanceof LmsHttpError || error instanceof IdentityError;
      const protocol = error instanceof LTIError;
      const status = known ? error.status : protocol ? 403 : 503;
      if ([429, 503].includes(status)) res.setHeader('Retry-After', '30');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: {
            code: known ? error.code : protocol ? `lti_${error.code}` : 'lms_unavailable',
            message: known
              ? error.message
              : protocol
                ? 'This Canvas launch could not be verified. Return to Canvas and restart it.'
                : 'Canvas launch is temporarily unavailable. Retry shortly; your local work is unchanged.',
          },
        }),
      );
    } finally {
      if (admitted) active--;
    }
    return true;
  };
}
