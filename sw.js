const CACHE_NAME = 'amino-shell-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/data-layer.js',
  '/matrix.js',
  '/src/formulas/bridge.js',
  '/src/formulas/parser.js',
  '/src/formulas/compiler.js',
  '/src/formulas/ui.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // Never proxy third-party APIs/assets through SW.
    return;
  }

  const isShellAsset = (
    req.mode === 'navigate' ||
    req.destination === 'document' ||
    req.destination === 'script' ||
    req.destination === 'style'
  );

  if (!isShellAsset) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Refresh in background so next launch gets updates.
        fetch(req).then((res) => {
          if (res && res.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, res));
          }
        }).catch(() => {});
        return cached;
      }

      return fetch(req).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      });
    })
  );
});
