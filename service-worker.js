const VERSION = '3.16.0';
const CACHE_PREFIX = 'ponndashi-cache-v';
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;

const urlsToCache = [
  './',
  './remote/',
  // @poncue-build-assets
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // Precache a complete version; updates wait until existing app windows close.
      .then(cache => cache.addAll(urlsToCache.map(url => new Request(url, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!['http:', 'https:'].includes(url.protocol)) return;
  // External fonts are optional; analytics and other third-party requests are not cached.
  if (url.origin !== self.location.origin && !['style', 'font'].includes(request.destination)) return;

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const isNavigation = request.mode === 'navigate';
  const cached = await cache.match(request, { ignoreSearch: isNavigation });
  if (cached) return cached;
  if (isNavigation) {
    // Never wait for an unstable connection when the installed app shell is available.
    const pathname = new URL(request.url).pathname;
    const fallback = pathname === '/remote' || pathname.startsWith('/remote/') ? './remote/' : './';
    const shell = await cache.match(fallback);
    if (shell) return shell;
  }
  try {
    const response = await fetch(request);
    if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
      await cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    return Response.error();
  }
}
