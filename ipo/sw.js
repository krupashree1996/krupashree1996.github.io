var CACHE = 'ipo-v6';
var PRECACHE = ['index.html', 'style.css', 'calc.js', 'app.js', 'data/bundle.js', 'manifest.json', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

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

/* Cache key = scope-relative path including the query string, so
 * query-parameterized URLs don't collide. */
function keyFor(url) {
  var p = url.pathname;
  var scopePath = new URL(self.registration.scope).pathname;
  if (scopePath.length > 1 && p.indexOf(scopePath) === 0) p = p.slice(scopePath.length);
  return p + url.search;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  var name = keyFor(url);
  if (name === '/index.html' || name === '/') {
    /* serve cache, revalidate in the background so deploys land without a
     * manual cache-bump. */
    e.respondWith(
      caches.match(name).then(function (hit) {
        var revalidate = fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(name, res.clone()); });
        }).catch(function () {});
        return hit || fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(name, res.clone()); });
          return res;
        });
      })
    );
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
