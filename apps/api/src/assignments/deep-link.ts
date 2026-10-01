import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { SignJWT, type JWK } from 'jose';
import { LTI_CLAIM } from '@margin/lms';
import { AssignmentError, type AssignmentRecord, type DeepLinkSelection } from './types.js';
const DL = 'https://purl.imsglobal.org/spec/lti-dl/claim/';
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
/** Tool-originating response signing only; no JWT asserts a user identity. */
export class AssignmentDeepLinkSigner {
  private readonly key: KeyObject;
  private readonly publicKey: JWK;
  constructor(
    private readonly keyId: string,
    privateKeyPem: string,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(keyId))
      throw new Error('Configure a bounded Deep Linking signing key ID.');
    this.key = createPrivateKey(privateKeyPem);
    if (
      this.key.asymmetricKeyType !== 'rsa' ||
      (this.key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      (this.key.asymmetricKeyDetails?.modulusLength ?? 0) > 4096
    )
      throw new Error('Deep Linking requires an RSA signing key of 2048–4096 bits.');
    this.publicKey = {
      ...createPublicKey(this.key).export({ format: 'jwk' }),
      kid: keyId,
      alg: 'RS256',
      use: 'sig',
    } as JWK;
  }
  jwks(): { keys: JWK[] } {
    return { keys: [structuredClone(this.publicKey)] };
  }
  async sign(
    selection: DeepLinkSelection,
    assignment: AssignmentRecord | null,
  ): Promise<{ returnUrl: string; JWT: string }> {
    const now = Math.floor(Date.now() / 1000);
    if (selection.expiresAt <= Date.now())
      throw new AssignmentError(
        409,
        'selection_expired',
        'The Canvas content selection expired. Start it again from Canvas.',
      );
    if (
      assignment &&
      (assignment.organizationId !== selection.organizationId ||
        assignment.installationId !== selection.installationId ||
        assignment.courseId !== selection.courseId ||
        assignment.createdBy !== selection.userId)
    )
      throw new AssignmentError(
        403,
        'selection_scope',
        'Select an assignment you authored in this Canvas course.',
      );
    const items = assignment
      ? [
          {
            type: 'ltiResourceLink',
            url: selection.launchUrl,
            title: assignment.title,
            custom: { margin_assignment_id: assignment.id },
            'https://canvas.instructure.com/lti/preserveExistingAssignmentName': true,
          },
        ]
      : [];
    const JWT = await new SignJWT({
      iss: selection.clientId,
      aud: selection.issuer,
      iat: now,
      exp: now + 300,
      nonce: randomBytes(32).toString('base64url'),
      [LTI_CLAIM + 'message_type']: 'LtiDeepLinkingResponse',
      [LTI_CLAIM + 'version']: '1.3.0',
      [LTI_CLAIM + 'deployment_id']: selection.deploymentId,
      [DL + 'content_items']: items,
      ...(selection.data !== undefined ? { [DL + 'data']: selection.data } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: this.keyId, typ: 'JWT' })
      .sign(this.key);
    return { returnUrl: selection.returnUrl, JWT };
  }
}
/** HTTPS adapter may return this document with its supplied headers after its own authentication/CSRF checks. */
export function deepLinkForm(response: { returnUrl: string; JWT: string }): {
  html: string;
  headers: Record<string, string>;
} {
  const url = new URL(response.returnUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    response.JWT.length > 32768 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(response.JWT)
  )
    throw new Error('Invalid signed Deep Linking response.');
  const nonce = randomBytes(24).toString('base64');
  return {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${url.origin}; frame-ancestors 'none'; base-uri 'none'`,
    },
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Return to Canvas</title><body><main><h1>Return to Canvas</h1><p>Canvas will review this content selection. This does not confirm that an assignment was published.</p><form id="canvas-return" method="post" action="${escape(response.returnUrl)}"><input type="hidden" name="JWT" value="${escape(response.JWT)}"><button type="submit">Continue to Canvas</button></form></main><script nonce="${nonce}">document.getElementById('canvas-return').submit();</script></body></html>`,
  };
}
