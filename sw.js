/* Stock Duel service worker — shell cache v3.
   Do not intercept this script. The previous worker cached sw.js cache-first,
   so a byte-identical cached copy blocked later deploys. HTML stays network-first
   (cache: reload) and falls back to the shell only when offline. */
const CACHE = 'stock-duel-shell-v3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept cross-origin (PeerJS CDN, signaling, etc.) — keep multiplayer intact
  if (url.origin !== self.location.origin) return;

  // Let the browser fetch sw.js itself so update checks see new bytes.
  if (url.pathname.endsWith('/sw.js')) return;

  // Network-first for HTML/navigation so Pages updates show up; fall back to cache offline.
  // cache:'reload' bypasses the browser HTTP cache that was pinning the previous shell.
  const isNav = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isNav || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req.url, {cache: 'reload', credentials: 'same-origin'});
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (e) {
        const cached = await caches.match(req);
        return cached || caches.match('./index.html');
      }
    })());
    return;
  }

  // Cache-first for local static assets (icons, manifest)
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
