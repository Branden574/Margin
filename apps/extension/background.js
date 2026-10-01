import { DEFAULT_WORKSPACE, handoffUrl } from './urls.js';
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'margin-open',
      title: 'Open document link in Margin',
      contexts: ['link', 'page'],
    });
  });
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'margin-open') return;
  const { workspace = DEFAULT_WORKSPACE } = await chrome.storage.local.get('workspace');
  try {
    const source = info.linkUrl || tab?.url;
    const url = handoffUrl(workspace, source);
    await chrome.tabs.create({ url });
    await chrome.storage.session.remove('handoffError');
    await chrome.action.setBadgeText({ text: '' });
  } catch (error) {
    await chrome.storage.session.set({
      handoffError: error.message || 'This document could not be opened.',
    });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b5473d' });
  }
});
