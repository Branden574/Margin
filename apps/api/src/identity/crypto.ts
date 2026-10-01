import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { IdentityError } from './types.js';

export const opaqueToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const isOpaqueToken = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
/** Call only with a verified issuer/subject or trusted provisioning input. Never an email claim. */
export function identityLookupKey(key: Uint8Array, issuer: string, subject: string): string {
  if (key.byteLength !== 32 || !issuer || !subject || subject.length > 255)
    throw new Error('Invalid identity lookup input.');
  return createHmac('sha256', key)
    .update(JSON.stringify([issuer, subject]))
    .digest('hex');
}
export interface LoginCookie {
  version: 1;
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
  returnTo: string;
  organizationId?: string;
}
export function createCookieCrypto(secret: Uint8Array, origin: string) {
  if (secret.byteLength !== 32)
    throw new Error('Session secret must contain exactly 32 random bytes.');
  const encryptionKey = Buffer.from(
    hkdfSync('sha256', secret, origin, 'margin-identity-login-v1', 32),
  );
  const csrfKey = Buffer.from(hkdfSync('sha256', secret, origin, 'margin-identity-csrf-v1', 32));
  const aad = Buffer.from(`margin-identity-login-v1:${origin}`);
  return {
    seal(value: LoginCookie): string {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
    },
    open(value: string): LoginCookie {
      try {
        if (value.length > 3000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
        const bytes = Buffer.from(value, 'base64url');
        if (bytes.length < 29) throw new Error();
        const cipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
        cipher.setAAD(aad);
        cipher.setAuthTag(bytes.subarray(12, 28));
        const decoded = JSON.parse(
          Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
        ) as LoginCookie;
        if (
          decoded.version !== 1 ||
          !isOpaqueToken(decoded.state) ||
          !isOpaqueToken(decoded.nonce) ||
          !isOpaqueToken(decoded.verifier) ||
          !Number.isSafeInteger(decoded.expiresAt) ||
          typeof decoded.returnTo !== 'string'
        )
          throw new Error();
        return decoded;
      } catch {
        throw new IdentityError(
          400,
          'invalid_login',
          'This sign-in attempt is invalid or expired. Start sign-in again.',
        );
      }
    },
    csrf(sessionToken: string): string {
      return createHmac('sha256', csrfKey).update(sessionToken).digest('base64url');
    },
  };
}
