// background.js — service worker (MV3) for Drive Video Downloader.
//
// Re-injects the extension into the MAIN world and the isolated world on
// Drive file-view pages (drive.google.com/file/d/*). The Drive viewer is
// an SPA, so this tries on 'loading' (as early as possible) and retries on
// 'complete'; both scripts have a guard against double injection. The main
// injection is the manifest content scripts (document_start); this is a
// fallback in case the page was already loaded when the extension was
// installed/enabled, or navigation did not trigger the content script.
//
// content.js is injected first, so it is listening before hook.js starts
// forwarding captures.
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
    files: ['content.js']
  }).catch(function () {
    // The tab may have been closed, or the document may not be ready yet
    // (on 'loading'); the 'complete' attempt covers it.
  });
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ['hook.js'],
    world: 'MAIN'
  }).catch(function () {
    // Same as above.
  });
});
