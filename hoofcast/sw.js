/*
 * HoofCast service worker.
 *
 * Bump CACHE_VERSION whenever CONFIG.VERSION in index.html changes, so a
 * new deploy busts any previously cached app shell.
 *
 * Strategy: cache-first for the same-origin static shell (HTML, manifest,
 * icons) so the app still opens offline / on a flaky connection. Everything
 * cross-origin -- Open-Meteo forecasts/geocoding, Zippopotam zip lookups --
 * is left completely untouched (no respondWith), so weather data is never
 * served stale from a cache.
 */
var CACHE_VERSION = '0.0.6';
var CACHE_NAME = 'hoofcast-' + CACHE_VERSION;

var STATIC_ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'horse-facts.js',
  'icons/favicon-16.png',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(STATIC_ASSETS.map(function (url) {
        return fetch(url, { cache: 'reload' }).then(function (resp) {
          return cache.put(url, resp);
        });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key !== CACHE_NAME;
      }).map(function (key) {
        return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (resp) {
        if (resp && resp.ok) {
          var copy = resp.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return resp;
      }).catch(function () { return cached; });
    })
  );
});
