/* Resonant service worker — caches the app shell so it opens offline.
   Your imported audio lives in IndexedDB, which works offline already.
   YouTube playback obviously needs a connection.                        */

const CACHE = 'resonant-v1';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // a missing optional asset must not block install
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache YouTube, Google APIs, or anything cross-origin — always go to network.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
          return r;
        })
        .catch(() => caches.match('./index.html').then(r => r || Response.error()))
    );
    return;
  }

  // Same-origin assets: cache first, refresh in the background.
  e.respondWith(
    caches.match(request).then(hit => {
      const net = fetch(request).then(r => {
        if (r && r.status === 200) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
        }
        return r;
      }).catch(() => hit || Response.error());
      return hit || net;
    })
  );
});
