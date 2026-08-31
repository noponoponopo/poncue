const VERSION = '3.15.0';
const CACHE_NAME = `ponndashi-cache-v${VERSION}`;

const urlsToCache = [
  './',
  './index.html',
  // @poncue-build-assets
  // External resources
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        const requests = urlsToCache.map(url => new Request(url, { cache: 'reload' }));
        // The build script injects every generated Vite asset (including the worklet).
        // Cache each available asset independently so one optional external URL
        // cannot abort SW installation.
        return Promise.all(requests.map(request => cache.add(request).catch(() => null)));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isNavigation = request.mode === 'navigate';
  const isCriticalAsset = url.origin === self.location.origin && (
    ['script', 'style', 'worker'].includes(request.destination) ||
    url.pathname.startsWith('/modules/')
  );

  if (isNavigation || isCriticalAsset) {
    event.respondWith(networkFirst(request, isNavigation));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirst(request, isNavigation) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: isNavigation });
    if (cached) return cached;
    if (isNavigation) return cache.match('./index.html');
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return cached || Response.error();
  }
}
