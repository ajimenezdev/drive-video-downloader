// test-extension.js — tests for hook.js + content.js with stubs and
// anonymized playback fixtures. Simulates the browser (window.fetch,
// XMLHttpRequest, history, postMessage, minimal DOM) and checks that the
// hook captures the itag 18 link from a player response, that the content
// script binds it to the file being viewed, and that navigating between
// videos never offers a stale URL.
//
// Two genuinely separate worlds: hook.js runs in a MAIN-world vm context,
// content.js in an isolated-world vm context. Each world has its own
// window, document, location and history stub objects — as in real Chrome,
// where the two worlds have separate JS globals. What they share is only
// what Chrome itself shares: one DOM tree (the document stubs are
// separate objects over the same element tree) and one address bar (the
// location stubs are separate objects over the same URL state). The only
// bridge between the worlds is window.postMessage, delivered from the
// MAIN window to the isolated world's message listeners, as in the real
// extension. (Stateless utilities — Blob, timers, console — are shared;
// each world still gets its own URL and XMLHttpRequest constructors.)
// postMessage delivery is synchronous here; in the browser it is async,
// which only changes timing, not ordering.
//
// Usage: node test/test-extension.js
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const fixtureA = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixture-response.json'), 'utf8'));
const fixtureB = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixture-response-b.json'), 'utf8'));
const hookCode = fs.readFileSync(path.join(ROOT, 'hook.js'), 'utf8');
const contentCode = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

const FILE_A = 'FILE_A_ID';
const FILE_B = 'FILE_B_ID';
const FILE_C = 'FILE_C_ID';
const FILE_PDF = 'FILE_PDF_ID';
const playbackUrl = (fileId) => 'https://workspacevideo-pa.clients6.google.com/v1/drive/media/' + fileId + '/playback?auditContext=forDisplay&key=AIzaSyDEMO';
const fileUrl = (fileId) => 'https://drive.google.com/file/d/' + fileId + '/view';

function freshCtx(fetchJson) {
  const created = [];
  const openedUrls = [];
  const blobUrls = [];

  function makeEl(tag) {
    const el = {
      tagName: tag.toUpperCase(), children: [], style: {}, listeners: {},
      textContent: '', id: '', className: '', href: '', download: '',
      __clicked: false, onclick: null, __parent: null,
      setAttribute(k, v) { this[k] = v; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      appendChild(c) { c.__parent = this; this.children.push(c); return c; },
      click() {
        this.__clicked = true;
        if (typeof this.onclick === 'function') { this.onclick(); }
        (this.listeners.click || []).forEach(fn => fn.call(this));
      },
      remove() {
        // Detach from the tree, like the real DOM: descendants go with it.
        if (this.__parent) {
          const siblings = this.__parent.children;
          const i = siblings.indexOf(this);
          if (i !== -1) { siblings.splice(i, 1); }
          this.__parent = null;
        }
        const j = created.indexOf(this);
        if (j !== -1) { created.splice(j, 1); }
      }
    };
    return el;
  }

  // The one shared address-bar state. Both worlds see the same URL (as in
  // real Chrome, where location is shared), but through separate location
  // stub objects.
  const sharedUrl = { href: fileUrl(FILE_A), pathname: '/file/d/' + FILE_A + '/view' };
  const ORIGIN = 'https://drive.google.com';
  function setSharedUrl(url) {
    const u = new URL(url, sharedUrl.href);
    sharedUrl.href = u.href;
    sharedUrl.pathname = u.pathname;
  }
  function makeLocation() {
    return {
      get href() { return sharedUrl.href; },
      get pathname() { return sharedUrl.pathname; },
      origin: ORIGIN
    };
  }
  // Separate history objects per world. The MAIN one is the page's router
  // history (the hook wraps it); the isolated one is a plain stub — the
  // content script never touches history itself.
  function makeHistory() {
    return {
      pushState(state, title, url) { if (url) { setSharedUrl(url); } },
      replaceState(state, title, url) { if (url) { setSharedUrl(url); } }
    };
  }

  // One shared DOM tree (as in real Chrome), reached through a separate
  // document stub object per world.
  const bodyEl = makeEl('body');
  const htmlEl = makeEl('html');
  function makeDocument() {
    return {
      createElement(tag) { const el = makeEl(tag); created.push(el); return el; },
      body: bodyEl,
      documentElement: htmlEl,
      getElementById(id) {
        // Walk the tree from the roots, like the real DOM: removing the box
        // removes its descendants too.
        const walk = (el) => {
          if (el.id === id) { return el; }
          for (const child of el.children || []) {
            const found = walk(child);
            if (found) { return found; }
          }
          return null;
        };
        return walk(this.body) || walk(this.documentElement);
      }
    };
  }

  // Separate window objects per world. The only bridge is postMessage:
  // the MAIN window delivers to the isolated world's message listeners
  // (event.source is the isolated window, as the content script's
  // `event.source === window` check expects for a same-window message).
  const isoMessageListeners = [];
  const mainLocation = makeLocation();
  const isoLocation = makeLocation();
  const mainWindow = {
    location: mainLocation,
    history: makeHistory(),
    fetch(url) {
      void url;
      return Promise.resolve({
        clone() { return { json: async () => ctx.fetchJson }; },
        json: async () => ctx.fetchJson
      });
    },
    open(url) { openedUrls.push(url); return null; },
    postMessage(msg, targetOrigin) {
      if (targetOrigin !== '*' && targetOrigin !== ORIGIN) { return; }
      isoMessageListeners.slice().forEach(fn => fn.call(isoWindow, { data: msg, origin: ORIGIN, source: isoWindow }));
    },
    addEventListener(type, fn) {
      (this.__listeners = this.__listeners || {})[type] = ((this.__listeners || {})[type] || []).concat(fn);
    }
  };
  const isoWindow = {
    location: isoLocation,
    history: makeHistory(),
    fetch(url) {
      void url;
      return Promise.resolve({
        clone() { return { json: async () => ctx.fetchJson }; },
        json: async () => ctx.fetchJson
      });
    },
    open(url) { openedUrls.push(url); return null; },
    postMessage(msg, targetOrigin) {
      if (targetOrigin !== '*' && targetOrigin !== ORIGIN) { return; }
      isoMessageListeners.slice().forEach(fn => fn.call(isoWindow, { data: msg, origin: ORIGIN, source: isoWindow }));
    },
    addEventListener(type, fn) {
      if (type === 'message') { isoMessageListeners.push(fn); }
      else { (this.__listeners = this.__listeners || {})[type] = ((this.__listeners || {})[type] || []).concat(fn); }
    }
  };
  function deliverMessage(event) {
    isoMessageListeners.slice().forEach(fn => fn.call(isoWindow, event));
  }
  function dispatchPopState() {
    const listeners = (isoWindow.__listeners || {}).popstate || [];
    listeners.forEach(fn => fn.call(isoWindow, { type: 'popstate' }));
  }

  const mainDocument = makeDocument();
  const isoDocument = makeDocument();

  function makeFakeXHR() {
    return class FakeXHR {
      constructor() {
        this.__listeners = {};
        this.responseText = '';
        this.response = null;
        this.responseType = '';
        this.status = 200;
      }
      open(method, url) { this.__url = url; }
      send() {}
      addEventListener(type, fn) { (this.__listeners[type] = this.__listeners[type] || []).push(fn); }
      _load() { (this.__listeners.load || []).forEach(fn => fn.call(this)); }
    };
  }

  function makeURLStub() {
    return class URLStub extends URL {
      static createObjectURL(blob) { blobUrls.push(blob); return 'blob:test-' + blobUrls.length; }
      static revokeObjectURL() {}
    };
  }

  const ctx = {
    fetchJson,
    created, openedUrls, blobUrls,
    mainWindow, isoWindow, mainLocation, isoLocation,
    mainDocument, isoDocument,
    deliverMessage, dispatchPopState,
    setLocation(url) { setSharedUrl(url); },
    setFetchJson(json) { ctx.fetchJson = json; },
    // Drive navigates to another file via the History API — the page's
    // router calls MAIN-world history, which the hook wraps.
    navigate(fileId) { mainWindow.history.pushState({}, '', fileUrl(fileId)); },
    navigateTo(url) { mainWindow.history.pushState({}, '', url); },
    button() { return isoDocument.getElementById('drive-video-downloader-btn'); },
    box() { return isoDocument.getElementById('drive-video-downloader-box'); }
  };

  const mainSandbox = {
    window: mainWindow,
    document: mainDocument,
    XMLHttpRequest: makeFakeXHR(),
    Blob: globalThis.Blob,
    URL: makeURLStub(),
    setTimeout,
    setInterval,
    clearInterval,
    console
  };
  const isoSandbox = {
    window: isoWindow,
    document: isoDocument,
    XMLHttpRequest: makeFakeXHR(),
    Blob: globalThis.Blob,
    URL: makeURLStub(),
    setTimeout,
    setInterval,
    clearInterval,
    console
  };
  ctx.mainSandbox = mainSandbox;
  ctx.isoSandbox = isoSandbox;
  vm.runInNewContext(contentCode, ctx.isoSandbox);
  vm.runInNewContext(hookCode, ctx.mainSandbox);
  return ctx;
}

function playViaXHR(ctx, fileId, json) {
  const xhr = new ctx.mainSandbox.XMLHttpRequest();
  xhr.open('GET', playbackUrl(fileId));
  xhr.send();
  xhr.responseText = JSON.stringify(json);
  xhr._load();
}

const tick = () => new Promise(r => setTimeout(r, 20));
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

// --- Behaviour carried over from v1.0 (adapted to the two-script load) ---

async function testXHR() {
  const c = freshCtx(fixtureA);
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  const btn = c.button();
  check('XHR: the "Download video" button appears', !!btn && btn.textContent.indexOf('Download video') !== -1);
  btn.click();
  check('XHR: click opens the itag 18 link', c.openedUrls.length === 1 && c.openedUrls[0].indexOf('itag=18') !== -1, JSON.stringify(c.openedUrls));
}

async function testFetch() {
  const c = freshCtx(fixtureA);
  await c.mainWindow.fetch(playbackUrl(FILE_A));
  await tick();
  const btn = c.button();
  check('fetch: the "Download video" button appears', !!btn && btn.textContent.indexOf('Download video') !== -1);
  btn.click();
  check('fetch: click opens the itag 18 link', c.openedUrls.length === 1 && c.openedUrls[0].indexOf('itag=18') !== -1);
}

async function testFallback() {
  const noLink = { mediaStreamingData: { formatStreamingData: { progressiveTranscodes: [] } } };
  const c = freshCtx(noLink);
  playViaXHR(c, FILE_A, noLink);
  await tick();
  const btn = c.button();
  check('fallback: the "Save response.json" button appears', !!btn && btn.textContent.indexOf('Save response.json') !== -1);
  btn.click();
  await tick();
  const blob = c.blobUrls[0];
  const text = blob ? await blob.text() : '';
  check('fallback: the Blob holds the response JSON', !!blob && text === JSON.stringify(noLink), 'blob: ' + String(text).slice(0, 60));
  const a = c.created.find(e => e.tagName === 'A');
  check('fallback: an <a download="response.json"> is created and clicked', !!a && a.download === 'response.json' && a.__clicked);
}

async function testErrorAndOther() {
  const errJson = { error: { code: 403, message: 'permission denied', status: 'PERMISSION_DENIED' } };
  const c = freshCtx(errJson);
  playViaXHR(c, FILE_A, errJson);
  await tick();
  check('error 403: no button appears', !c.button());

  const c2 = freshCtx(fixtureA);
  const xhr2 = new c2.mainSandbox.XMLHttpRequest();
  xhr2.open('GET', 'https://drive.google.com/drive/api/files');
  xhr2.send();
  xhr2.responseText = JSON.stringify(fixtureA);
  xhr2._load();
  await tick();
  check('non-playback URL: ignored even with a real-looking body', !c2.button());
}

async function testDoubleInjection() {
  const c = freshCtx(fixtureA);
  vm.runInNewContext(hookCode, c.mainSandbox); // second hook injection
  vm.runInNewContext(contentCode, c.isoSandbox); // second content injection
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  const boxes = c.created.filter(e => e.id === 'drive-video-downloader-box');
  check('double injection: only one box is created', boxes.length === 1, 'boxes: ' + boxes.length);
  const btn = c.button();
  btn.click();
  check('double injection: the button still opens itag 18', c.openedUrls.length === 1 && c.openedUrls[0].indexOf('itag=18') !== -1);
}

// --- PR 1: per-video state and SPA navigation ---

async function testNavigateAToB() {
  const c = freshCtx(fixtureA);
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  check('A->B: button for A appears', !!c.button());
  c.navigate(FILE_B);
  await tick();
  check('A->B: button is gone right after navigating to B', !c.button(), 'button still present');
  playViaXHR(c, FILE_B, fixtureB);
  await tick();
  const btn = c.button();
  check('A->B: button for B appears', !!btn && btn.textContent.indexOf('Download video') !== -1);
  btn.click();
  check('A->B: click opens B only, never A', c.openedUrls.length === 1 && c.openedUrls[0].indexOf('file=B') !== -1 && c.openedUrls[0].indexOf('file=A') === -1, JSON.stringify(c.openedUrls));
}

async function testNavigateBWithoutLink() {
  const noLinkB = { mediaStreamingData: { formatStreamingData: { progressiveTranscodes: [] } } };
  const c = freshCtx(fixtureA);
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  c.navigate(FILE_B);
  await tick();
  playViaXHR(c, FILE_B, noLinkB);
  await tick();
  const btn = c.button();
  check('A->B no link: no "Download video" button for B', !btn || btn.textContent.indexOf('Download video') === -1);
  if (btn) { btn.click(); await tick(); }
  check('A->B no link: nothing is opened (A is never offered)', c.openedUrls.length === 0, JSON.stringify(c.openedUrls));
  const blob = c.blobUrls[0];
  const text = blob ? await blob.text() : '';
  check('A->B no link: fallback blob (if any) holds B, not A', !blob || text === JSON.stringify(noLinkB));
}

async function testNavigateToNonVideo() {
  const c = freshCtx(fixtureA);
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  check('A->PDF: button for A appears', !!c.button());
  c.navigate(FILE_PDF);
  await tick();
  check('A->PDF: button is gone, no playback ever arrives', !c.button());
}

async function testRepeatedNavigation() {
  const c = freshCtx(fixtureA);
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  c.navigate(FILE_B);
  c.navigate(FILE_C);
  c.navigate(FILE_B);
  await tick();
  check('A->B->C->B: button is gone after repeated navigation', !c.button());
  // A late response for B arrives while the viewer is back on B — it is
  // for the current file, so it is accepted.
  playViaXHR(c, FILE_B, fixtureB);
  await tick();
  const btn = c.button();
  check('A->B->C->B: button for B appears after its capture', !!btn);
  btn.click();
  check('A->B->C->B: click opens B only', c.openedUrls.length === 1 && c.openedUrls[0].indexOf('file=B') !== -1, JSON.stringify(c.openedUrls));
}

async function testStaleCaptureIgnored() {
  const c = freshCtx(fixtureA);
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  c.navigate(FILE_B);
  await tick();
  // Late response for A arrives while B is on screen: its request URL
  // still names A, so the content script must ignore it.
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  check('stale capture: late A response while on B shows no button', !c.button());
  check('stale capture: nothing opened', c.openedUrls.length === 0);
  playViaXHR(c, FILE_B, fixtureB);
  await tick();
  const btn = c.button();
  btn.click();
  check('stale capture: after B capture, click opens B only', c.openedUrls.length === 1 && c.openedUrls[0].indexOf('file=B') !== -1, JSON.stringify(c.openedUrls));
}

async function testLateResponseNoIdInRequestUrl() {
  const c = freshCtx(fixtureA);
  // Playback request URL with NO file ID in it (only '/drive/media/' +
  // 'playback'): the hook must bind the capture to the file on screen
  // when the request STARTS, not when the response arrives.
  const noIdUrl = 'https://workspacevideo-pa.clients6.google.com/v1/drive/media/playback?auditContext=forDisplay&key=AIzaSyDEMO';
  const xhr = new c.mainSandbox.XMLHttpRequest();
  xhr.open('GET', noIdUrl);
  xhr.send();
  // Navigate to B before the response arrives.
  c.navigate(FILE_B);
  await tick();
  check('late no-ID response: no button while on B (before response)', !c.button());
  xhr.responseText = JSON.stringify(fixtureA);
  xhr._load();
  await tick();
  check('late no-ID response: still no button on B after A response arrives', !c.button());
  check('late no-ID response: nothing opened, nothing offered for B', c.openedUrls.length === 0 && c.blobUrls.length === 0, JSON.stringify(c.openedUrls));
  // And B still works normally once its own capture arrives.
  playViaXHR(c, FILE_B, fixtureB);
  await tick();
  const btn = c.button();
  btn.click();
  check('late no-ID response: after B capture, click opens B only', c.openedUrls.length === 1 && c.openedUrls[0].indexOf('file=B') !== -1, JSON.stringify(c.openedUrls));
}

async function testRoundTrip() {
  const c = freshCtx(fixtureA);
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  c.navigate(FILE_B);
  await tick();
  c.navigate(FILE_A);
  await tick();
  check('A->B->A: button is gone before A is captured again', !c.button());
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  const btn = c.button();
  check('A->B->A: button for A appears again', !!btn);
  btn.click();
  check('A->B->A: click opens A', c.openedUrls.length === 1 && c.openedUrls[0].indexOf('itag=18') !== -1 && c.openedUrls[0].indexOf('file=B') === -1, JSON.stringify(c.openedUrls));
}

async function testForgedMessages() {
  const c = freshCtx(fixtureA);
  const good = { source: 'drive-video-downloader-hook', type: 'playback', fileId: FILE_A, url: 'https://example.com/videoplayback?itag=18&file=A', jsonText: null };
  const forged = [
    ['wrong source marker', { source: 'something-else', type: 'playback', fileId: FILE_A, url: good.url, jsonText: null }],
    ['wrong type', { source: 'drive-video-downloader-hook', type: 'other', fileId: FILE_A, url: good.url, jsonText: null }],
    ['fileId with illegal characters', { source: 'drive-video-downloader-hook', type: 'playback', fileId: '../../etc', url: good.url, jsonText: null }],
    ['fileId of another video', { source: 'drive-video-downloader-hook', type: 'playback', fileId: FILE_B, url: good.url, jsonText: null }],
    ['non-string url', { source: 'drive-video-downloader-hook', type: 'playback', fileId: FILE_A, url: 42, jsonText: null }],
    ['non-string jsonText', { source: 'drive-video-downloader-hook', type: 'playback', fileId: FILE_A, url: null, jsonText: 42 }]
  ];
  for (const [label, data] of forged) {
    c.deliverMessage({ data, origin: c.isoLocation.origin, source: c.isoWindow });
    await tick();
    check('forged message ignored: ' + label, !c.button() && c.openedUrls.length === 0);
  }
  c.deliverMessage({ data: good, origin: 'https://evil.example', source: c.isoWindow });
  await tick();
  check('forged message ignored: wrong origin', !c.button() && c.openedUrls.length === 0);
  c.deliverMessage({ data: good, origin: c.isoLocation.origin, source: {} });
  await tick();
  check('forged message ignored: wrong source window', !c.button() && c.openedUrls.length === 0);
  c.deliverMessage({ data: good, origin: c.isoLocation.origin, source: c.isoWindow });
  await tick();
  check('well-formed message for the current file is accepted', !!c.button());
}

async function testNavigateHome() {
  const c = freshCtx(fixtureA);
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  c.navigateTo('https://drive.google.com/drive/my-drive');
  await tick();
  check('A->home: button is gone on a non-file URL', !c.button());
}

async function testPollerFallback() {
  const c = freshCtx(fixtureA);
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  // URL change that bypasses the History API entirely.
  c.setLocation(fileUrl(FILE_B));
  await new Promise(r => setTimeout(r, 1300));
  check('poller fallback: direct URL change hides the button', !c.button());
}

async function testClickRacingNavigation() {
  const c = freshCtx(fixtureA);
  playViaXHR(c, FILE_A, fixtureA);
  await tick();
  const btn = c.button();
  // Navigate without the History API and click before the 1s poller runs:
  // the click handler must re-check the live URL and open nothing.
  c.setLocation(fileUrl(FILE_B));
  btn.click();
  check('click racing navigation: nothing opens for the previous video', c.openedUrls.length === 0, JSON.stringify(c.openedUrls));
}

(async () => {
  await testXHR();
  await testFetch();
  await testFallback();
  await testErrorAndOther();
  await testDoubleInjection();
  await testNavigateAToB();
  await testNavigateBWithoutLink();
  await testNavigateToNonVideo();
  await testRepeatedNavigation();
  await testStaleCaptureIgnored();
  await testLateResponseNoIdInRequestUrl();
  await testRoundTrip();
  await testForgedMessages();
  await testNavigateHome();
  await testPollerFallback();
  await testClickRacingNavigation();
  console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
