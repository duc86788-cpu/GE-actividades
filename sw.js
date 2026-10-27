/* GE Actividades service worker — offline shell only; API always goes to the network */
const CACHE = 'ge-shell-v10';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;          // POST/PATCH/DELETE always hit the server
  if (url.pathname.startsWith('/api/')) return;    // data is never served from cache

  // app shell: cache-first, refresh in background
  if (url.origin === location.origin && (url.pathname === '/' || url.pathname === '/app.html')) {
    e.respondWith(
      caches.match('/').then(hit => {
        const fresh = fetch(e.request).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put('/', res.clone()));
          return res.clone();
        }).catch(() => hit);
        return hit || fresh;
      })
    );
    return;
  }

  // other same-origin assets: try cache, then network
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok && (url.pathname.startsWith('/icon-') || url.pathname === '/manifest.json')) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res.clone();
      }))
    );
  }
});
