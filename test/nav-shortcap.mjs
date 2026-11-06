/**
 * Host/guest accounting tests for live net equity and the $200,000 short cap.
 * Usage: node test/nav-shortcap.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = '/opt/cursor/artifacts';
const CHROME = process.env.CHROME_PATH || 'google-chrome';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function startServer(){
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found ' + pathname); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

class CDP {
  constructor(ws){
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.paused = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Fetch.requestPaused') {
        this.onPaused(msg.params);
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const {resolve, reject} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}){
    const id = ++this.id;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
  async onPaused(p){
    const url = p.request.url || '';
    try {
      if (url.includes('unpkg.com')) {
        await this.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [{name: 'Content-Type', value: 'application/javascript'}],
          body: Buffer.from('/* peerjs stub for offline tests */\n').toString('base64')
        });
      } else {
        await this.send('Fetch.continueRequest', {requestId: p.requestId});
      }
    } catch (e) {
      console.error('fetch intercept', e);
    }
  }
}

async function waitJson(url){
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(100);
  }
  throw new Error('Chrome DevTools port did not open: ' + url);
}

async function evaluate(cdp, expression, awaitPromise = false){
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    timeout: 60000
  });
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    throw new Error(d.text + (d.exception && d.exception.description ? '\n' + d.exception.description : ''));
  }
  return result.result.value;
}

async function screenshot(cdp, file){
  const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
  await mkdir(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

async function main(){
  const server = await startServer();
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const profile = await mkdtemp(path.join(tmpdir(), 'stock-duel-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--lang=zh-TW',
    '--window-size=1500,1200',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    'about:blank'
  ], {stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  chrome.stderr.on('data', d => { stderr += d.toString(); });
  let debugSettled = false;
  const debugMatch = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no devtools port\n' + stderr)), 15000);
    chrome.stderr.on('data', () => {
      const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m && !debugSettled) { debugSettled = true; clearTimeout(t); resolve(m[1]); }
    });
    chrome.on('exit', code => {
      if (!debugSettled) { debugSettled = true; clearTimeout(t); reject(new Error('chrome exited ' + code + '\n' + stderr)); }
    });
  });
  const httpBase = debugMatch.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
  const ver = await waitJson(httpBase + '/json/version');
  const browser = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    browser.addEventListener('open', resolve);
    browser.addEventListener('error', () => reject(new Error('browser websocket failed\n' + stderr)));
  });
  const bcdp = new CDP(browser);
  const {targetId} = await bcdp.send('Target.createTarget', {url: 'about:blank'});
  const targets = await waitJson(httpBase + '/json/list');
  const page = targets.find(t => t.id === targetId);
  if (!page) throw new Error('missing page target ' + JSON.stringify(targets));
  const pageWs = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    pageWs.addEventListener('open', resolve);
    pageWs.addEventListener('error', () => reject(new Error('page websocket failed')));
  });
  const cdp = new CDP(pageWs);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*://unpkg.com/*', requestStage: 'Request'}]});
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{sessionStorage.setItem('sd-sw-refresh','1')}catch(e){}"
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1500, height: 1200, deviceScaleFactor: 1, mobile: false});

  const failShot = '/tmp/stock-duel-fail.png';
  try {
    await cdp.send('Page.navigate', {url: origin + '/test/harness.html?assert=1'});
    let result = null;
    let lastEval = '';
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      try {
        result = await evaluate(cdp, 'window.__result || null');
        if (result) break;
      } catch (e) { lastEval = e.message; }
    }
    if (!result) {
      await screenshot(cdp, failShot);
      const status = await evaluate(cdp, 'document.getElementById("status") && document.getElementById("status").textContent');
      throw new Error('harness timed out. status=' + status + ' last=' + lastEval + ' shot=' + failShot);
    }
    if (!result.ok) {
      await screenshot(cdp, failShot);
      const passed = (result.log || []).length;
      throw new Error(result.error + '\npassed ' + passed + ' checks before failure\n' + (result.log || []).slice(-8).join('\n') + '\nshot=' + failShot);
    }
    console.log(result.log.join('\n'));
    console.log('VISUAL host ' + result.host + ' guest ' + result.guest + ' (' + result.log.length + ' checks)');

    await mkdir(ARTIFACTS, {recursive: true});
    await screenshot(cdp, path.join(ARTIFACTS, 'live_nav_and_short_cap.png'));
    await evaluate(cdp, 'window.__layout = function(mode){ const h=document.getElementById("pane-host"), g=document.getElementById("pane-guest"); if(mode==="guest"){ h.style.display="none"; } else { h.style.display=""; } }');
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 2, mobile: true});
    await evaluate(cdp, 'window.__layout("guest")');
    await sleep(200);
    await screenshot(cdp, path.join(ARTIFACTS, 'guest_live_nav_mobile.png'));
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1500, height: 1200, deviceScaleFactor: 1, mobile: false});

    await cdp.send('Page.navigate', {url: origin + '/index.html'});
    await sleep(500);
    const sw = await evaluate(cdp, `navigator.serviceWorker.ready.then(reg => ({
      scriptURL: reg.active && reg.active.scriptURL,
      updateViaCache: reg.updateViaCache,
      keys: null
    }))`, true);
    const keys = await evaluate(cdp, 'caches.keys()', true);
    if (!sw.scriptURL || !sw.scriptURL.includes('sw.js?v=3')) throw new Error('SW script URL ' + sw.scriptURL);
    if (sw.updateViaCache !== 'none') throw new Error('updateViaCache ' + sw.updateViaCache);
    if (!keys.includes('stock-duel-shell-v3')) throw new Error('cache keys ' + keys.join(','));
    console.log('PASS service worker active ' + sw.scriptURL + ' cache ' + keys.join(','));

    const poisoned = await evaluate(cdp, `(async () => {
      const cache = await caches.open('stock-duel-shell-v3');
      await cache.put(new Request(new URL('sw.js?v=3', location.href).toString()), new Response('STALE_SW'));
      await cache.put('./index.html', new Response('STALE_HTML'));
      const swText = await fetch('sw.js?v=3', {cache:'no-store'}).then(r => r.text());
      const html = await fetch('./index.html', {cache:'reload'}).then(r => r.text());
      return {swStale: swText.includes('STALE_SW'), swOk: swText.includes('stock-duel-shell-v3'), htmlStale: html.includes('STALE_HTML'), htmlOk: html.includes('$200,000')};
    })()`, true);
    if (poisoned.swStale || !poisoned.swOk) throw new Error('sw.js was served from the cache: ' + JSON.stringify(poisoned));
    if (poisoned.htmlStale || !poisoned.htmlOk) throw new Error('index.html ignored the network: ' + JSON.stringify(poisoned));
    console.log('PASS poisoned cache does not pin sw.js or index.html');

    await evaluate(cdp, `caches.open('stock-duel-shell-v2').then(c => c.put('./old', new Response('old-shell')))`, true);
    await cdp.send('Network.emulateNetworkConditions', {offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0});
    const offline = await evaluate(cdp, `fetch('./index.html').then(r => r.text()).then(t => ({ok: t.includes('$200,000') && !t.includes('STALE_HTML'), len: t.length})).catch(e => ({ok:false, err:String(e)}))`, true);
    await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    if (!offline.ok) throw new Error('offline shell fallback failed ' + JSON.stringify(offline));
    console.log('PASS offline navigation falls back to the cached shell');

    await evaluate(cdp, `navigator.serviceWorker.getRegistration().then(r => r.unregister())`, true);
    await cdp.send('Page.navigate', {url: origin + '/index.html'});
    await sleep(400);
    const keys2 = await evaluate(cdp, `navigator.serviceWorker.ready.then(() => caches.keys())`, true);
    if (keys2.includes('stock-duel-shell-v2')) throw new Error('old cache survived activate: ' + keys2.join(','));
    if (!keys2.includes('stock-duel-shell-v3')) throw new Error('v3 cache missing after reinstall: ' + keys2.join(','));
    console.log('PASS activate deletes stock-duel-shell-v2; keys ' + keys2.join(','));
    console.log('ALL TESTS PASSED');
  } finally {
    try { chrome.kill('SIGKILL'); } catch {}
    server.close();
    await rm(profile, {recursive: true, force: true});
  }
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
