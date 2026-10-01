import type { Page } from '../components/Sidebar';
const pages = new Set([
  'home',
  'documents',
  'starred',
  'assignments',
  'templates',
  'trash',
  'settings',
]);
export function parseRoute(hash: string): { page: Page; documentId: string | null } {
  let route: string;
  try {
    route = decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return { page: 'home', documentId: null };
  }
  if (route.startsWith('document/') && route.length > 9)
    return { page: 'home', documentId: route.slice(9) };
  if (pages.has(route) || /^folder:[a-zA-Z0-9_-]+$/.test(route))
    return { page: route as Page, documentId: null };
  return { page: 'home', documentId: null };
}
export async function fetchDocumentBlob(url: string, maxBytes = 100 * 1024 * 1024): Promise<Blob> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Document links must use HTTPS without embedded credentials.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`The source returned HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length') || 0) > maxBytes) {
      controller.abort();
      throw new Error('This document exceeds the 100 MB local import limit.');
    }
    if (!response.body) throw new Error('The source did not return a document.');
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        controller.abort();
        throw new Error('This document exceeds the 100 MB local import limit.');
      }
      chunks.push(new Uint8Array(value));
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || 'application/pdf' });
  } finally {
    clearTimeout(timer);
  }
}
