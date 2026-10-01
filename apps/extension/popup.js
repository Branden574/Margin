import { DEFAULT_WORKSPACE, workspaceUrl, handoffUrl } from './urls.js';
const status = document.querySelector('#status');
const input = document.querySelector('#workspace');
const report = (message, isError = false) => {
  status.textContent = message;
  status.classList.toggle('error', isError);
};
const settings = await chrome.storage.local.get('workspace');
input.value = settings.workspace || DEFAULT_WORKSPACE;
const { handoffError } = await chrome.storage.session.get('handoffError');
if (handoffError) {
  report(handoffError, true);
  await chrome.storage.session.remove('handoffError');
  await chrome.action.setBadgeText({ text: '' });
}
document.querySelector('#settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const url = workspaceUrl(input.value.trim()).href;
    await chrome.storage.local.set({ workspace: url });
    input.value = url;
    report('Workspace saved.');
  } catch (error) {
    report(error.message, true);
  }
});
async function launch(withCurrentPage) {
  try {
    const { workspace = DEFAULT_WORKSPACE } = await chrome.storage.local.get('workspace');
    let source;
    if (withCurrentPage) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url)
        throw new Error(
          'This browser page cannot be shared. Go to the workspace to import a file.',
        );
      source = tab.url;
    }
    await chrome.tabs.create({ url: handoffUrl(workspace, source) });
    window.close();
  } catch (error) {
    report(error.message || 'The workspace could not be opened.', true);
  }
}
document.querySelector('#open-current').addEventListener('click', () => launch(true));
document.querySelector('#open-workspace').addEventListener('click', () => launch(false));
