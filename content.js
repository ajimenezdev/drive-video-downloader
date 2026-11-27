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
// - On navigation the captured URL and the button are discarded. The
//   MAIN-world hook (hook.js) wraps history.pushState/replaceState and
//   notifies this script with a 'dvd-navigation' message carrying the
//   new URL; a popstate listener and a 1 s interval poller are fallbacks
//   for URL changes that reach us no other way. (The history wrapper
//   deliberately does NOT live here: patching history from the isolated
//   world would only shadow this script's own copy and would never see
//   the page's calls.)
// - The button is only shown once a URL for the current file arrives, and
//   the click handler re-checks the file ID at click time, so even a click
//   racing a navigation cannot open a stale URL.
//
// Message validation: a message is accepted only when it comes from this
// same window and origin, has the expected marker and type, and carries a
// well-formed fileId plus a string URL (or a string JSON fallback). Note
// this stops cross-origin forgery, but a script running in the page itself
// could still forge a same-origin message — that is why the open point
// below is the only place that opens a URL, and it only opens googlevideo
// URLs (exact host or a subdomain of googlevideo.com, checked by exact
// comparison / proper suffix, never substring matching), with
// noopener/noreferrer. A forged message can therefore never turn the
// button into an opener for an arbitrary site.
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

  // File ID carried by a URL string (used for navigation messages, which
  // bring the new URL with them).
  function fileIdFromUrl(url) {
    try {
      var m = new URL(url).pathname.match(/\/file\/d\/([^/]+)/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
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
  // discard everything captured for the previous one. When the new URL is
  // known (navigation message from the hook), use it; otherwise read the
  // address bar live.
  function onUrlChange(url) {
    var now = typeof url === 'string' && url ? fileIdFromUrl(url) : currentFileId();
    if (now === lastFileId) {
      return;
    }
    lastFileId = now;
    captured = null;
    fallback = null;
    hideButton();
  }

  // Navigation detection: the primary signal is the 'dvd-navigation'
  // message from the MAIN-world hook (see the message listener below).
  // popstate and the interval are fallbacks for URL changes that reach
  // us no other way.
  (function watchNavigation() {
    window.addEventListener('popstate', function () { onUrlChange(); });
    setInterval(onUrlChange, URL_CHECK_MS);
  })();

  // Parse a playback URL and allowlist it: absolute URL, exactly https:,
  // and host googlevideo.com or a subdomain of it. Checked by exact
  // comparison and a proper '.googlevideo.com' suffix — never includes()
  // or substring matching, so lookalikes are rejected:
  // googlevideo.com.evil.com, evilgooglevideo.com, googlevideo.com@evil.com
  // (the URL parser puts the host after '@', so that one is evil.com).
  // Returns the parsed URL, or null. Fail closed: anything else opens
  // nothing and is never offered by the button.
  function parsePlaybackUrl(url) {
    var parsed = null;
    try {
      parsed = new URL(url);
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== 'https:') {
      return null;
    }
    var host = parsed.hostname;
    if (host !== 'googlevideo.com' && !host.endsWith('.googlevideo.com')) {
      return null;
    }
    return parsed;
  }

  // Single place that opens a captured URL. The URL is validated by
  // parsePlaybackUrl above (https + googlevideo host) and opened with
  // noopener/noreferrer, so the opened page gets no window.opener and
  // no referrer.
  function openPlaybackUrl(url) {
    var parsed = parsePlaybackUrl(url);
    if (!parsed) {
      return;
    }
    window.open(parsed.href, '_blank', 'noopener,noreferrer');
  }

  // Short, legible error text for a failed capture. The HTTP status is
  // shown in the button when known (e.g. "Couldn't detect the video
  // (403)"); the note explains what happened in plain words.
  function errorButtonText(code) {
    if (/^[0-9]+$/.test(code)) {
      return "Couldn't detect the video (" + code + ")";
    }
    return "Couldn't detect the video";
  }
  function errorNoteText(code) {
    if (/^[0-9]+$/.test(code)) {
      return 'The player returned an error (' + code + '). Try reloading the page.';
    }
    if (code === 'invalid-json') {
      return 'The player returned an unreadable response. Try reloading the page.';
    }
    if (code === 'aborted') {
      return 'The request was interrupted. Try reloading the page.';
    }
    if (code === 'timeout') {
      return 'The request timed out. Try reloading the page.';
    }
    if (code === 'network') {
      return 'The request failed. Check your connection and try reloading the page.';
    }
    return 'The video could not be detected. Try reloading the page.';
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
      btnEl.disabled = false;
      noteEl.textContent = 'Click to open the video in a new tab, then download it from the player (⋮ → Download).';
      btnEl.onclick = function () {
        // Re-check at click time: a navigation racing the click must not
        // open the previous video's URL.
        if (!captured || captured.fileId !== currentFileId()) {
          return;
        }
        openPlaybackUrl(captured.url);
      };
    } else if (mode === 'error') {
      // A failed capture is visible instead of silent: a disabled button
      // with the short error state, so nothing is offered and a click
      // opens nothing.
      btnEl.textContent = errorButtonText(payload);
      btnEl.disabled = true;
      noteEl.textContent = errorNoteText(payload);
      btnEl.onclick = null;
    } else {
      btnEl.textContent = '⬇ Save response.json';
      btnEl.disabled = false;
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
    // Navigation notice from the MAIN-world hook: the page navigated
    // (history API), with the new URL attached.
    if (data && typeof data === 'object' && data.source === MESSAGE_SOURCE &&
        data.type === 'dvd-navigation') {
      if (typeof data.url === 'string' && data.url) {
        onUrlChange(data.url);
      }
      return;
    }
    // Capture error from the MAIN-world hook: the player's request for
    // this video failed. Show it as a visible error state — but only
    // when there is nothing better for the current file already (never
    // downgrade a video link or a JSON fallback we already have).
    if (data && typeof data === 'object' && data.source === MESSAGE_SOURCE &&
        data.type === 'dvd-capture-error') {
      if (typeof data.fileId === 'string' && FILE_ID_PATTERN.test(data.fileId) &&
          typeof data.code === 'string' && data.code &&
          data.fileId === currentFileId() && !captured && !fallback) {
        showButton('error', data.code);
      }
      return;
    }
    if (!isValidMessage(data)) {
      return;
    }
    // Stale capture: for a video that is no longer on screen.
    if (data.fileId !== currentFileId()) {
      return;
    }
    // Only offer URLs that pass the allowlist (https + googlevideo host).
    // Anything else is rejected here, at receipt, so the button never
    // offers it; the open point re-checks anyway (defence in depth).
    if (typeof data.url === 'string' && data.url && parsePlaybackUrl(data.url)) {
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
