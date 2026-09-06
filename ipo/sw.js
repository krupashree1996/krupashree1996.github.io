var CACHE = 'ipo-v2';
var PRECACHE = ['index.html', 'style.css', 'calc.js', 'app.js', 'data/bundle.js', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  var name = url.pathname.replace(/^\/+/, '') || 'index.html';
  if (name === 'index.html') {
    e.respondWith(caches.match(name).then(function (hit) { return hit || fetch(req); }));
    return;
  }
  e.respondWith(
    caches.match(name).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(name, res.clone()); });
        return res;
      });
    })
  );
});