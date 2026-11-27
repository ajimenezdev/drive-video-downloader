// hook.js — Drive Video Downloader (MAIN world).
//
// Watches the requests the Drive player itself makes and captures the
// download link for the video. It does NOT re-issue the request: re-fetching
// the playback URL from a bookmarklet or the console fails with 403
// PERMISSION_DENIED even while the video is playing in that same session.
// Here we only read the response the player already receives.
//
// - Wraps window.fetch and XMLHttpRequest (the player uses XHR).
// - When a response comes from the playback API (URL with '/drive/media/'
//   and 'playback'), reads the body, parses the JSON and extracts the
//   progressive link (itag 18, else 22, else the first one).
// - When the link is captured, shows a fixed 'Download video' button; on
//   click (a user gesture) it opens the link in a new tab, where the video
//   can be downloaded from the player (⋮ → Download).
// - If the response has no link, shows a button that downloads the
//   response as response.json instead.
// - Sends nothing anywhere: everything stays between the browser and Google.
(function () {
  if (window.__driveVideoDownloaderHookInstalled) {
    return;
  }
  window.__driveVideoDownloaderHookInstalled = true;

  var capturedUrl = null;

  function isPlaybackUrl(url) {
    if (typeof url !== 'string') {
      return false;
    }
    return url.indexOf('/drive/media/') !== -1 && url.indexOf('playback') !== -1;
  }

  // Extract the progressive link from a playback API response.
  function pickProgressive(json) {
    var fsd = json && json.mediaStreamingData && json.mediaStreamingData.formatStreamingData;
    var prog = (fsd && fsd.progressiveTranscodes) || [];
    var want = [18, 22];
    for (var k = 0; k < want.length; k++) {
      for (var i = 0; i < prog.length; i++) {
        if (String(prog[i].itag) === String(want[k]) && prog[i].url) {
          return prog[i].url;
        }
      }
    }
    if (prog.length && prog[0].url) {
      return prog[0].url;
    }
    var found = null;
    (function walk(o) {
      if (!o || found) {
        return;
      }
      if (typeof o === 'object') {
        if ((o.itag === 18 || o.itag === '18') && typeof o.url === 'string') {
          found = o.url;
          return;
        }
        for (var key in o) {
          walk(o[key]);
        }
      }
    })(json);
    return found;
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
        window.open(payload, '_blank');
      };
    } else {
      btnEl.textContent = '⬇ Save response.json';
      noteEl.textContent = 'No download link found in the response. Save this file to inspect it.';
      btnEl.onclick = function () {
        var blob = new Blob([payload], { type: 'application/json' });
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

  function handleJson(json, jsonText) {
    var video = null;
    try {
      video = pickProgressive(json);
    } catch (e) {
      video = null;
    }
    if (video) {
      capturedUrl = video;
      showButton('video', video);
      return;
    }
    // No link: don't downgrade if we already have one. Only offer the JSON
    // if the response is from the playback API (it has mediaStreamingData).
    if (capturedUrl) {
      return;
    }
    if (json && json.mediaStreamingData) {
      showButton('json', jsonText || JSON.stringify(json));
    }
  }

  // 1) fetch (in case the player uses it somewhere).
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      var url = '';
      try {
        var first = arguments[0];
        url = typeof first === 'string' ? first : (first && first.url) || '';
      } catch (e) {
        url = '';
      }
      var p = origFetch.apply(this, arguments);
      if (isPlaybackUrl(url)) {
        p.then(function (resp) {
          try {
            resp.clone().json().then(function (j) {
              handleJson(j, null);
            }).catch(function () {});
          } catch (e) {}
        }).catch(function () {});
      }
      return p;
    };
  }

  // 2) XMLHttpRequest (the path the player uses).
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__driveVideoDownloaderUrl = url;
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (xhr.__driveVideoDownloaderUrl && isPlaybackUrl(xhr.__driveVideoDownloaderUrl)) {
      xhr.addEventListener('load', function () {
        try {
          if (xhr.responseType === 'json' && xhr.response) {
            handleJson(xhr.response, JSON.stringify(xhr.response));
            return;
          }
          var text = xhr.responseText;
          if (text) {
            handleJson(JSON.parse(text), text);
          }
        } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();
