// test-extension.js — tests for hook.js with stubs and an anonymized
// playback fixture. Simulates the browser (window.fetch, XMLHttpRequest,
// minimal DOM) and checks that the hook captures the itag 18 link from a
// player response and that the button opens it.
// Usage: node test/test-extension.js
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const fixtureJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixture-response.json'), 'utf8'));
const hookCode = fs.readFileSync(path.join(ROOT, 'hook.js'), 'utf8');

const PLAYBACK_URL = 'https://workspacevideo-pa.clients6.google.com/v1/drive/media/DEMO_FILE_ID/playback?auditContext=forDisplay&key=AIzaSyDEMO';

function makeEl(tag) {
  return {
    tagName: tag.toUpperCase(), children: [], style: {}, listeners: {},
    textContent: '', id: '', className: '', href: '', download: '',
    __clicked: false, onclick: null,
    setAttribute(k, v) { this[k] = v; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
    click() {
      this.__clicked = true;
      if (typeof this.onclick === 'function') { this.onclick(); }
      (this.listeners.click || []).forEach(fn => fn.call(this));
    },
    remove() {}
  };
}

class FakeXHR {
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
}

function freshCtx(fetchJson) {
  const created = [];
  const openedUrls = [];
  const blobUrls = [];
  const documentStub = {
    createElement(tag) { const el = makeEl(tag); created.push(el); return el; },
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById(id) {
      const all = created.concat([this.body, this.documentElement]);
      return all.find(e => e.id === id) || null;
    }
  };
  const windowStub = {
    fetch() {
      return Promise.resolve({
        clone() { return { json: async () => fetchJson }; },
        json: async () => fetchJson
      });
    },
    open(url) { openedUrls.push(url); return null; }
  };
  const sandbox = {
    window: windowStub,
    document: documentStub,
    XMLHttpRequest: FakeXHR,
    Blob: globalThis.Blob,
    URL: {
      createObjectURL(blob) { blobUrls.push(blob); return 'blob:test-' + blobUrls.length; },
      revokeObjectURL() {}
    },
    setTimeout,
    console
  };
  return { sandbox, created, openedUrls, blobUrls, documentStub, windowStub };
}

const tick = () => new Promise(r => setTimeout(r, 20));
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

async function testXHR() {
  const c = freshCtx(fixtureJson);
  vm.runInNewContext(hookCode, c.sandbox);
  const xhr = new c.sandbox.XMLHttpRequest();
  xhr.open('GET', PLAYBACK_URL);
  xhr.send();
  xhr.responseText = JSON.stringify(fixtureJson);
  xhr._load();
  await tick();
  const btn = c.documentStub.getElementById('drive-video-downloader-btn');
  check('XHR: the "Download video" button appears', !!btn && btn.textContent.indexOf('Download video') !== -1);
  btn.click();
  check('XHR: click opens the itag 18 link', c.openedUrls.length === 1 && c.openedUrls[0].indexOf('itag=18') !== -1, JSON.stringify(c.openedUrls));
}

async function testFetch() {
  const c = freshCtx(fixtureJson);
  vm.runInNewContext(hookCode, c.sandbox);
  await c.sandbox.window.fetch(PLAYBACK_URL);
  await tick();
  const btn = c.documentStub.getElementById('drive-video-downloader-btn');
  check('fetch: the "Download video" button appears', !!btn && btn.textContent.indexOf('Download video') !== -1);
  btn.click();
  check('fetch: click opens the itag 18 link', c.openedUrls.length === 1 && c.openedUrls[0].indexOf('itag=18') !== -1);
}

async function testFallback() {
  const noLink = { mediaStreamingData: { formatStreamingData: { progressiveTranscodes: [] } } };
  const c = freshCtx(noLink);
  vm.runInNewContext(hookCode, c.sandbox);
  const xhr = new c.sandbox.XMLHttpRequest();
  xhr.open('GET', PLAYBACK_URL);
  xhr.send();
  xhr.responseText = JSON.stringify(noLink);
  xhr._load();
  await tick();
  const btn = c.documentStub.getElementById('drive-video-downloader-btn');
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
  vm.runInNewContext(hookCode, c.sandbox);
  const xhr = new c.sandbox.XMLHttpRequest();
  xhr.open('GET', PLAYBACK_URL);
  xhr.send();
  xhr.responseText = JSON.stringify(errJson);
  xhr._load();
  await tick();
  check('error 403: no button appears', !c.documentStub.getElementById('drive-video-downloader-btn'));

  const c2 = freshCtx(fixtureJson);
  vm.runInNewContext(hookCode, c2.sandbox);
  const xhr2 = new c2.sandbox.XMLHttpRequest();
  xhr2.open('GET', 'https://drive.google.com/drive/api/files');
  xhr2.send();
  xhr2.responseText = JSON.stringify(fixtureJson);
  xhr2._load();
  await tick();
  check('non-playback URL: ignored even with a real-looking body', !c2.documentStub.getElementById('drive-video-downloader-btn'));
}

async function testDoubleInjection() {
  const c = freshCtx(fixtureJson);
  vm.runInNewContext(hookCode, c.sandbox);
  vm.runInNewContext(hookCode, c.sandbox); // second injection: the guard stops it
  const xhr = new c.sandbox.XMLHttpRequest();
  xhr.open('GET', PLAYBACK_URL);
  xhr.send();
  xhr.responseText = JSON.stringify(fixtureJson);
  xhr._load();
  await tick();
  const boxes = c.created.filter(e => e.id === 'drive-video-downloader-box');
  check('double injection: only one box is created', boxes.length === 1, 'boxes: ' + boxes.length);
  const btn = c.documentStub.getElementById('drive-video-downloader-btn');
  btn.click();
  check('double injection: the button still opens itag 18', c.openedUrls.length === 1 && c.openedUrls[0].indexOf('itag=18') !== -1);
}

(async () => {
  await testXHR();
  await testFetch();
  await testFallback();
  await testErrorAndOther();
  await testDoubleInjection();
  console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
