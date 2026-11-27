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
//   bound to the file the player actually requested: the file ID is
//   captured when the request starts — from the request URL
//   (/drive/media/<fileId>/playback), or from the address bar at that
//   moment when the URL carries none — and kept with the request until
//   its response is processed. The address bar is never read when the
//   response arrives: by then the viewer may have navigated to another
//   video and the capture would be misattributed to it.
// - When a request fails, it forwards a structured error to the content
//   script ('dvd-capture-error' with the file ID and a short code: the
//   HTTP status, 'invalid-json', 'aborted', 'timeout' or 'network'),
//   so the failure is visible instead of silent. A successful capture
//   is still forwarded as before.
// - It also wraps window.history.pushState/replaceState (MAIN world only:
//   the page's router calls MAIN-world history, so a wrapper anywhere
//   else would not see its calls) and notifies the content script of
//   SPA navigation via postMessage. The content script keeps its own
//   1 s poller as a fallback.
// - Sends nothing anywhere: everything stays between the browser and Google.
(function () {
  if (window.__driveVideoDownloaderHookInstalled) {
    return;
  }
  window.__driveVideoDownloaderHookInstalled = true;

  var MESSAGE_SOURCE = 'drive-video-downloader-hook';

  // File ID from a playback request URL only — no address-bar fallback
  // here. The fallback is taken once, when the request starts (see
  // fileIdAtRequestStart), and kept with the request until its response
  // is processed.
  function fileIdFromRequestUrl(requestUrl) {
    if (typeof requestUrl === 'string') {
      var m = requestUrl.match(/\/drive\/media\/([^/?#]+)\/playback/);
      if (m) {
        return m[1];
      }
    }
    return null;
  }

  // Capture the file ID when a request starts: from its URL, or from the
  // address bar at that moment when the URL carries none. The value is
  // kept with the request (closure for fetch, property for XHR) and used
  // when the response arrives. Never read the address bar at response
  // time — by then the viewer may have navigated to another video.
  // When neither source has an ID, the result is null and the capture
  // is dropped (it cannot be attributed to any video).
  function fileIdAtRequestStart(requestUrl) {
    var fromUrl = fileIdFromRequestUrl(requestUrl);
    if (fromUrl) {
      return fromUrl;
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

  // Forward a capture to the content script. The fileId was captured
  // when the request started; a capture without one cannot be attributed
  // to a video, so it is dropped.
  function postCapture(fileId, url, jsonText) {
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

  // Forward a capture error to the content script, so a failed request is
  // visible instead of silent. The code is a short string: the HTTP status
  // ('403', '404', '500', ...), 'invalid-json' when the response body is
  // not parseable JSON, 'aborted' when the request was aborted, 'timeout'
  // when it timed out, or 'network' for any other failure. The fileId was
  // captured when the request started; an error without one cannot be
  // attributed to a video, so it is dropped.
  function postCaptureError(fileId, code) {
    if (!fileId) {
      return;
    }
    window.postMessage({
      source: MESSAGE_SOURCE,
      type: 'dvd-capture-error',
      fileId: fileId,
      code: code
    }, window.location.origin);
  }

  function handleResponse(fileId, json, jsonText) {
    var video = null;
    try {
      video = pickProgressive(json);
    } catch (e) {
      video = null;
    }
    if (video) {
      postCapture(fileId, video, null);
      return;
    }
    // No link: forward the response anyway when it comes from the playback
    // API (it has mediaStreamingData). The content script only offers the
    // JSON fallback when it has no video URL for the current file.
    if (json && json.mediaStreamingData) {
      postCapture(fileId, null, jsonText || JSON.stringify(json));
    }
  }

  // Notify the content script that the address bar changed. The new URL
  // travels in the message so the content script does not have to guess
  // which file the viewer is on now.
  function postNavigation() {
    window.postMessage({
      source: MESSAGE_SOURCE,
      type: 'dvd-navigation',
      url: window.location.href
    }, window.location.origin);
  }

  // SPA navigation: Drive changes videos through the History API without
  // reloading. This wrapper must live in the MAIN world — the page's
  // router calls MAIN-world history, so a wrapper in the isolated world
  // would only shadow the content script's own copy and never see the
  // page's calls. The install guard above keeps the wrapper installed
  // exactly once even if the hook is injected again.
  (function watchNavigation() {
    var historyObj = window.history;
    if (!historyObj) {
      return;
    }
    ['pushState', 'replaceState'].forEach(function (method) {
      var orig = historyObj[method];
      if (typeof orig !== 'function') {
        return;
      }
      historyObj[method] = function () {
        var result = orig.apply(this, arguments);
        postNavigation();
        return result;
      };
    });
    window.addEventListener('popstate', postNavigation);
  })();

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
        // Bind the file ID now, while the request starts — not when the
        // response arrives.
        var fileId = fileIdAtRequestStart(url);
        p.then(function (resp) {
          try {
            // HTTP error status (403/404/500, ...): report it and do not
            // try to parse the body as a playback response. Checked on
            // the status number when present, falling back to resp.ok.
            var httpStatus = resp && typeof resp.status === 'number' ? resp.status : null;
            if (httpStatus !== null ? httpStatus >= 400 : (resp && resp.ok === false)) {
              postCaptureError(fileId, httpStatus !== null ? String(httpStatus) : 'network');
              return;
            }
            resp.clone().json().then(function (j) {
              handleResponse(fileId, j, null);
            }).catch(function () {
              // The body is not parseable JSON.
              postCaptureError(fileId, 'invalid-json');
            });
          } catch (e) {}
        }).catch(function (err) {
          // The request itself failed: aborted (AbortController) or any
          // other failure (network, ...).
          postCaptureError(fileId, err && err.name === 'AbortError' ? 'aborted' : 'network');
        });
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
      // Bind the file ID when the request is set up — not when its
      // response arrives.
      this.__driveVideoDownloaderFileId = fileIdAtRequestStart(url);
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (xhr.__driveVideoDownloaderUrl && isPlaybackUrl(xhr.__driveVideoDownloaderUrl)) {
      xhr.addEventListener('load', function () {
        try {
          // HTTP error status: the load event still fires for 4xx/5xx.
          if (typeof xhr.status === 'number' && xhr.status >= 400) {
            postCaptureError(xhr.__driveVideoDownloaderFileId, String(xhr.status));
            return;
          }
          if (xhr.responseType === 'json' && xhr.response) {
            handleResponse(xhr.__driveVideoDownloaderFileId, xhr.response, JSON.stringify(xhr.response));
            return;
          }
          var text = xhr.responseText;
          if (text) {
            var parsed;
            try {
              parsed = JSON.parse(text);
            } catch (e) {
              // The body is not parseable JSON.
              postCaptureError(xhr.__driveVideoDownloaderFileId, 'invalid-json');
              return;
            }
            handleResponse(xhr.__driveVideoDownloaderFileId, parsed, text);
          } else {
            // A 200 with an empty body: nothing parseable came back.
            postCaptureError(xhr.__driveVideoDownloaderFileId, 'invalid-json');
          }
        } catch (e) {}
      });
      xhr.addEventListener('error', function () {
        postCaptureError(xhr.__driveVideoDownloaderFileId, 'network');
      });
      xhr.addEventListener('abort', function () {
        postCaptureError(xhr.__driveVideoDownloaderFileId, 'aborted');
      });
      xhr.addEventListener('timeout', function () {
        postCaptureError(xhr.__driveVideoDownloaderFileId, 'timeout');
      });
    }
    return origSend.apply(this, arguments);
  };
})();
