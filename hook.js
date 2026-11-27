// hook.js — Drive Video Downloader (MAIN world, capture only).
//
// Watches the requests the Drive player itself makes and forwards what it
// sees to the content script (content.js, isolated world) via
// window.postMessage. It does NOT re-issue the request: re-fetching the
// playback URL from a bookmarklet or the console fails with 403
// PERMISSION_DENIED even while the video is playing in that same session.
// Here we only read the response the player already receives.
//
// - Wraps window.fetch and XMLHttpRequest (the player uses XHR).
// - When a response arrives from the playback API (URL with '/drive/media/'
//   and 'playback'), parses the JSON and extracts the progressive link
//   (itag 18, else 22, else the first one). Quality selection is unchanged
//   in this PR (a quality picker is planned separately).
// - It never touches the DOM and never opens anything. The captured URL is
//   bound to the file the player actually requested: the file ID is taken
//   from the request URL (/drive/media/<fileId>/playback), falling back to
//   the address bar when the request URL carries none. That binding is what
//   lets the content script ignore captures for a video the user already
//   left (Drive navigates between videos without reloading the page).
// - Sends nothing anywhere: everything stays between the browser and Google.
(function () {
  if (window.__driveVideoDownloaderHookInstalled) {
    return;
  }
  window.__driveVideoDownloaderHookInstalled = true;

  var MESSAGE_SOURCE = 'drive-video-downloader-hook';

  // File ID of the video the player requested, from the playback request
  // URL. Falls back to the address bar when the URL carries no file ID.
  function fileIdFromRequest(requestUrl) {
    if (typeof requestUrl === 'string') {
      var m = requestUrl.match(/\/drive\/media\/([^/?#]+)\/playback/);
      if (m) {
        return m[1];
      }
    }
    var loc = window.location.pathname.match(/\/file\/d\/([^/]+)/);
    return loc ? loc[1] : null;
  }

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

  // Forward a capture to the content script. A capture without a file ID
  // cannot be attributed to a video, so it is dropped.
  function postCapture(requestUrl, url, jsonText) {
    var fileId = fileIdFromRequest(requestUrl);
    if (!fileId) {
      return;
    }
    window.postMessage({
      source: MESSAGE_SOURCE,
      type: 'playback',
      fileId: fileId,
      url: url || null,
      jsonText: jsonText || null
    }, window.location.origin);
  }

  function handleResponse(requestUrl, json, jsonText) {
    var video = null;
    try {
      video = pickProgressive(json);
    } catch (e) {
      video = null;
    }
    if (video) {
      postCapture(requestUrl, video, null);
      return;
    }
    // No link: forward the response anyway when it comes from the playback
    // API (it has mediaStreamingData). The content script only offers the
    // JSON fallback when it has no video URL for the current file.
    if (json && json.mediaStreamingData) {
      postCapture(requestUrl, null, jsonText || JSON.stringify(json));
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
              handleResponse(url, j, null);
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
            handleResponse(xhr.__driveVideoDownloaderUrl, xhr.response, JSON.stringify(xhr.response));
            return;
          }
          var text = xhr.responseText;
          if (text) {
            handleResponse(xhr.__driveVideoDownloaderUrl, JSON.parse(text), text);
          }
        } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();
