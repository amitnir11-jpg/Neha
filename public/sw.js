/* eslint-disable no-restricted-globals */
(function () {
  const APP_VERSION = '20260627-cross-bin-confirm-v1';
  const CACHE_NAME = `daksh-static-${APP_VERSION}`;
  const STATIC_EXTENSIONS = new Set([
    '.css',
    '.js',
    '.mjs',
    '.map',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.webp',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot'
  ]);

  function extensionFromUrl(url = '') {
    try {
      const pathname = new URL(url, self.location.origin).pathname || '';
      const match = pathname.toLowerCase().match(/\.[a-z0-9]+$/);
      return match ? match[0] : '';
    } catch (_) {
      return '';
    }
  }

  function isStaticAsset(request, url) {
    if (request.method !== 'GET') return false;
    if (request.mode === 'navigate' || request.destination === 'document') return false;
    if (url.origin !== self.location.origin) return false;
    if (url.pathname.startsWith('/api/')) return false;
    if (url.pathname.startsWith('/socket.io/')) return false;
    if (url.pathname === '/config.js' || url.pathname === '/health') return false;
    if (url.pathname === '/' || url.pathname === '/login' || url.pathname === '/dashboard' || url.pathname === '/report' || url.pathname === '/scan') return false;
    const ext = extensionFromUrl(url.href);
    return STATIC_EXTENSIONS.has(ext);
  }

  async function deleteOldCaches() {
    const keys = await caches.keys().catch(() => []);
    await Promise.all(keys.map((key) => {
      if (key === CACHE_NAME) return Promise.resolve(false);
      return caches.delete(key).catch(() => false);
    }));
  }

  self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      await self.skipWaiting();
    })());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      await deleteOldCaches();
      await self.clients.claim();
    })());
  });

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (!isStaticAsset(request, url)) {
      event.respondWith(fetch(request));
      return;
    }

    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreSearch: false });
      if (cached) {
        event.waitUntil((async () => {
          try {
            const response = await fetch(request);
            if (response && response.ok) await cache.put(request, response.clone());
          } catch (_) {}
        })());
        return cached;
      }

      try {
        const response = await fetch(request);
        if (response && response.ok) await cache.put(request, response.clone());
        return response;
      } catch (error) {
        const fallback = await cache.match(request, { ignoreSearch: false }).catch(() => null);
        if (fallback) return fallback;
        throw error;
      }
    })());
  });
})();
