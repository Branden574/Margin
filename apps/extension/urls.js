export const DEFAULT_WORKSPACE = 'https://localhost:5173/';
export function workspaceUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.protocol !== 'https:') {
    throw new Error(
      'Use an HTTPS workspace URL. Plaintext HTTP is not permitted, including localhost.',
    );
  }
  url.hash = '';
  url.search = '';
  return url;
}
export function handoffUrl(workspace, source) {
  const target = workspaceUrl(workspace);
  if (source) {
    const document = new URL(source);
    if (document.protocol !== 'https:' || document.username || document.password) {
      throw new Error(
        'Open an HTTPS document link. Local files can be imported directly in Margin.',
      );
    }
    // Keep access tokens and fragment credentials out of the handoff. Signed URLs must be imported manually.
    if (document.search || document.hash)
      throw new Error(
        'This link contains query parameters or a fragment. Open Margin and import the downloaded document instead.',
      );
    target.searchParams.set('source', document.href);
  }
  return target.href;
}
