import * as oidc from 'openid-client';
import { IdentityError, type IdentityConfig } from './types.js';

export interface OidcTestOptions {
  /** Synthetic test issuer transport; refused outside NODE_ENV=test. Never disables HTTPS checks. */
  testFetch?: oidc.CustomFetch;
}
export function secureUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new Error(`${label} must be HTTPS without credentials, query, or fragment.`);
  return url;
}
export async function discoverProvider(config: IdentityConfig, options: OidcTestOptions = {}) {
  if (options.testFetch && process.env.NODE_ENV !== 'test')
    throw new Error('Synthetic issuer transport is available only in tests.');
  const issuer = secureUrl(config.issuerUrl, 'OIDC issuer');
  const origins = new Set([
    issuer.origin,
    ...(config.allowedProviderOrigins ?? []).map((value) => {
      const url = secureUrl(value, 'OIDC endpoint origin');
      if (url.origin !== value)
        throw new Error('OIDC endpoint allowlist entries must be exact origins.');
      return url.origin;
    }),
  ]);
  const transport: oidc.CustomFetch =
    options.testFetch ??
    ((input, init) =>
      fetch(input, {
        ...init,
        body: init.body instanceof Uint8Array ? new Uint8Array(init.body).buffer : init.body,
      }));
  const boundedFetch: oidc.CustomFetch = async (input, init) => {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || !origins.has(url.origin))
      throw new IdentityError(
        502,
        'issuer_endpoint_rejected',
        'The identity provider advertised an unapproved endpoint.',
      );
    const timeout = AbortSignal.timeout(8_000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await transport(input, { ...init, redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400)
      throw new Error('Identity endpoint redirects are not allowed.');
    if (Number(response.headers.get('content-length') ?? 0) > 131072) {
      await response.body?.cancel();
      throw new Error('Identity response exceeds its limit.');
    }
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 131072) throw new Error('Identity response exceeds its limit.');
          parts.push(part.value);
        }
      } catch (error) {
        await reader.cancel();
        throw error;
      }
    }
    return new Response(Buffer.concat(parts), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  const client = await oidc.discovery(
    issuer,
    config.clientId,
    {
      client_secret: config.clientSecret,
      id_token_signed_response_alg: config.idTokenSigningAlgorithm ?? 'RS256',
    },
    oidc.ClientSecretBasic(config.clientSecret),
    {
      [oidc.customFetch]: boundedFetch,
      timeout: 8,
      execute: [oidc.enableNonRepudiationChecks],
    },
  );
  const metadata = client.serverMetadata();
  if (metadata.issuer !== config.issuerUrl)
    throw new Error('The discovered issuer does not match configuration.');
  for (const endpoint of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.jwks_uri,
  ]) {
    if (!endpoint)
      throw new Error('The OIDC provider must advertise authorization, token, and JWKS endpoints.');
    const url = secureUrl(endpoint, 'OIDC endpoint');
    if (!origins.has(url.origin))
      throw new Error('The OIDC provider advertised an unapproved endpoint origin.');
  }
  if (!metadata.code_challenge_methods_supported?.includes('S256'))
    throw new Error('The identity provider must advertise PKCE S256 support.');
  return client;
}
