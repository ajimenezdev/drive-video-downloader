// content.js — Drive Video Downloader (isolated world).
//
// Owns the per-video state, the button UI and the single place that opens a
// captured URL. The MAIN-world hook (hook.js) only observes the player's
// requests and forwards what it sees via window.postMessage; it never
// touches the DOM and never opens anything.
//
// State is bound to the file being viewed, so a URL captured for one video
// can never be offered for another:
//
// - The file ID is read live from the address bar (/file/d/<id>/).
// - Every capture carries the file ID of the video the player requested;
//   captures for any other file are ignored, including late responses that
//   arrive after the user already navigated away.
// - On navigation (history API, back/forward, or any URL change caught by
//   the fallback poller) the captured URL and the button are discarded.
// - The button is only shown once a URL for the current file arrives, and
//   the click handler re-checks the file ID at click time, so even a click
//   racing a navigation cannot open a stale URL.
//
// Message validation: a message is accepted only when it comes from this
// same window and origin, has the expected marker and type, and carries a
// well-formed fileId plus a string URL (or a string JSON fallback). Note
// this stops cross-origin forgery, but a script running in the page itself
// could still forge a same-origin message — that is why the open point
// below is the only place that opens a URL, and the strict host allowlist
// for it (googlevideo) is added in the next PR. Until then, the open point
// only accepts absolute https: URLs, so a forged message can never turn
// the button into a javascript:/data: opener.
(function () {
  if (window.__driveVideoDownloaderContentInstalled) {
    return;
  }
  window.__driveVideoDownloaderContentInstalled = true;

  var MESSAGE_SOURCE = 'drive-video-downloader-hook';
  var FILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
  var URL_CHECK_MS = 1000;

  // File ID of the video currently in the address bar, read live so a
  // click racing a navigation is still checked against the real URL.
  function currentFileId() {
    var m = window.location.pathname.match(/\/file\/d\/([^/]+)/);
    return m ? m[1] : null;
  }

  var lastFileId = currentFileId();
  var captured = null; // { fileId, url } for the current file, or null
  var fallback = null; // { fileId, jsonText } for the current file, or null

  function hideButton() {
    var box = document.getElementById('drive-video-downloader-box');
    if (box && box.remove) {
      box.remove();
    }
  }

  // Called whenever the address bar may have changed. If the file changed,
  // discard everything captured for the previous one.
  function onUrlChange() {
    var now = currentFileId();
    if (now === lastFileId) {
      return;
    }
    lastFileId = now;
    captured = null;
    fallback = null;
    hideButton();
  }

  // Detect Drive's SPA navigation: the viewer changes videos through the
  // History API without reloading. The interval is a fallback for any URL
  // change that bypasses the History API.
  (function watchNavigation() {
    var historyObj = window.history;
    if (historyObj) {
      ['pushState', 'replaceState'].forEach(function (method) {
        var orig = historyObj[method];
        if (typeof orig !== 'function') {
          return;
        }
        historyObj[method] = function () {
          var result = orig.apply(this, arguments);
          onUrlChange();
          return result;
        };
      });
      window.addEventListener('popstate', onUrlChange);
    }
    setInterval(onUrlChange, URL_CHECK_MS);
  })();

  // Single place that opens a captured URL. PR 2 adds the strict allowlist
  // (googlevideo host) and noopener/noreferrer here; PR 1 only guarantees
  // the value is an absolute https: URL.
  function openPlaybackUrl(url) {
    var parsed = null;
    try {
      parsed = new URL(url);
    } catch (e) {
      return;
    }
    if (!parsed || parsed.protocol !== 'https:') {
      return;
    }
    window.open(parsed.href, '_blank');
  }

  function showButton(mode, payload) {
    var box = document.getElementById('drive-video-downloader-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'drive-video-downloader-box';
      box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
        'background:#fff;border:2px solid #1a73e8;border-radius:10px;padding:12px 14px;' +
        'font-family:sans-serif;font-size:14px;color:#222;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:320px;';
      var btn = document.createElement('button');
      btn.id = 'drive-video-downloader-btn';
      btn.style.cssText = 'background:#1a73e8;color:#fff;border:0;border-radius:6px;' +
        'padding:10px 16px;font-size:15px;font-weight:bold;cursor:pointer;width:100%;';
      var note = document.createElement('div');
      note.id = 'drive-video-downloader-note';
      note.style.cssText = 'margin-top:8px;font-size:12px;color:#555;';
      box.appendChild(btn);
      box.appendChild(note);
      (document.body || document.documentElement).appendChild(box);
    }
    var btnEl = document.getElementById('drive-video-downloader-btn');
    var noteEl = document.getElementById('drive-video-downloader-note');
    if (mode === 'video') {
      btnEl.textContent = '⬇ Download video';
      noteEl.textContent = 'Click to open the video in a new tab, then download it from the player (⋮ → Download).';
      btnEl.onclick = function () {
        // Re-check at click time: a navigation racing the click must not
        // open the previous video's URL.
        if (!captured || captured.fileId !== currentFileId()) {
          return;
        }
        openPlaybackUrl(captured.url);
      };
    } else {
      btnEl.textContent = '⬇ Save response.json';
      noteEl.textContent = 'No download link found in the response. Save this file to inspect it.';
      btnEl.onclick = function () {
        if (!fallback || fallback.fileId !== currentFileId()) {
          return;
        }
        var blob = new Blob([fallback.jsonText], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'response.json';
        a.click();
        setTimeout(function () {
          URL.revokeObjectURL(a.href);
        }, 5000);
      };
    }
  }

  function isValidMessage(data) {
    if (!data || typeof data !== 'object') {
      return false;
    }
    if (data.source !== MESSAGE_SOURCE || data.type !== 'playback') {
      return false;
    }
    if (typeof data.fileId !== 'string' || !FILE_ID_PATTERN.test(data.fileId)) {
      return false;
    }
    if (data.url !== null && typeof data.url !== 'string') {
      return false;
    }
    if (data.jsonText !== null && typeof data.jsonText !== 'string') {
      return false;
    }
    return true;
  }

  window.addEventListener('message', function (event) {
    if (!event || event.source !== window) {
      return;
    }
    if (event.origin !== window.location.origin) {
      return;
    }
    var data = event.data;
    if (!isValidMessage(data)) {
      return;
    }
    // Stale capture: for a video that is no longer on screen.
    if (data.fileId !== currentFileId()) {
      return;
    }
    if (typeof data.url === 'string' && data.url) {
      captured = { fileId: data.fileId, url: data.url };
      fallback = null;
      showButton('video', data.url);
      return;
    }
    // No link for this video: only offer the JSON fallback when there is
    // no video URL for the current file, and never downgrade one we have.
    if (!captured && typeof data.jsonText === 'string' && data.jsonText) {
      fallback = { fileId: data.fileId, jsonText: data.jsonText };
      showButton('json', data.jsonText);
    }
  });
})();
