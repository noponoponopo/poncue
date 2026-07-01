// A more descriptive and easily updatable version
const VERSION = '3.11.0'; // Incremented version
const CACHE_NAME = `ponndashi-cache-v${VERSION}`;

// Add all the local module files to the cache list to ensure they are available offline.
const urlsToCache = [
  './',
  './index.html',
  './script.js',
  './style.css',
  './manifest.json',
  './modules/01_config.js',
  './modules/02_dom.js',
  './modules/03_state.js',
  './modules/04_db.js',
  './modules/05_ui.js',
  './modules/06_audio.js',
  './modules/07_scenes.js',
  './modules/08_handlers.js',
  './modules/09_effects.js',
  './modules/10_tone_transport.js',
  // External resources
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap'
];

// Install: Called when the service worker is first installed.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log(`[Service Worker] Caching files for version ${VERSION}`);
        const requests = urlsToCache.map(url => new Request(url, { cache: 'reload' })); // Force reload from network
        return cache.addAll(requests);
      })
      .then(() => {
        // Force the waiting service worker to become the active service worker.
        return self.skipWaiting();
      })
  );
});

// Activate: Called when the service worker is activated.
// This is a good time to clean up old caches.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // If the cache name is not the current one, delete it.
          if (cacheName !== CACHE_NAME) {
            console.log(`[Service Worker] Deleting old cache: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Tell the active service worker to take control of the page immediately.
      return self.clients.claim();
    })
  );
});

// Fetch: Intercept network requests.
// Using a Network First, then Cache strategy.
self.addEventListener('fetch', event => {
  // Ignore non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // For IndexedDB operations, do not intercept.
  if (event.request.url.includes('idb-keyval')) {
      return;
  }

  event.respondWith(
    // 1. Try to fetch from the network
    fetch(event.request)
      .then(networkResponse => {
        // If the fetch is successful, clone the response
        const responseToCache = networkResponse.clone();
        
        // Open the cache and store the new response
        caches.open(CACHE_NAME)
          .then(cache => {
            cache.put(event.request, responseToCache);
          });
          
        // Return the network response
        return networkResponse;
      })
      .catch(() => {
        // 2. If the network fetch fails (e.g., offline), try to get it from the cache
        return caches.match(event.request)
          .then(cachedResponse => {
            if (cachedResponse) {
              // Return the cached response if found
              return cachedResponse;
            }
            // If not in cache either, it's a real failure.
          });
      })
  );
});
