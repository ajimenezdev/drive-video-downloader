// background.js — service worker (MV3) for Drive Video Downloader.
//
// Re-injects hook.js into the MAIN world on Drive file-view pages
// (drive.google.com/file/d/*). The Drive viewer is an SPA, so this tries on
// 'loading' (as early as possible) and retries on 'complete'; hook.js has a
// guard against double injection. The main injection is the manifest
// content script (document_start, MAIN world); this is a fallback in case
// the page was already loaded when the extension was installed/enabled, or
// navigation did not trigger the content script.
var FILE_VIEW = /^https:\/\/drive\.google\.com\/file\/d\/[^/]+\//;

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (!tab || !tab.url || !FILE_VIEW.test(tab.url)) {
    return;
  }
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') {
    return;
  }
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ['hook.js'],
    world: 'MAIN'
  }).catch(function () {
    // The tab may have been closed, or the document may not be ready yet
    // (on 'loading'); the 'complete' attempt covers it.
  });
});
