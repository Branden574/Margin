export function safeWorkspaceUrl(value = process.env.NEXT_PUBLIC_WORKSPACE_URL): string {
  const url = new URL(value || 'https://127.0.0.1:5173/');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error(
      'NEXT_PUBLIC_WORKSPACE_URL must be an HTTPS workspace URL without credentials, query, or fragment.',
    );
  return url.href;
}
export const workspaceUrl = safeWorkspaceUrl();
export function safeSiteUrl(value = process.env.NEXT_PUBLIC_SITE_URL): string {
  const url = new URL(value || 'http://127.0.0.1:3000/');
  const localHttp = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (
    (!localHttp && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'NEXT_PUBLIC_SITE_URL must be an HTTPS origin, or HTTP 127.0.0.1 for local preview, without credentials, path, query, or fragment.',
    );
  return url.href;
}
export const siteUrl = safeSiteUrl();
