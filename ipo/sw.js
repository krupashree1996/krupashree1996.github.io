var CACHE = 'ipo-v17';
var PRECACHE = ['index.html', 'style.css', 'calc.js', 'app.js', 'data/bundle.js', 'manifest.json', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'GET_VERSION' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ version: CACHE });
  }
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
  /* Data endpoints (e.g. the calendar JSON) must always hit the network —
   * never serve or store them from the app cache. */
  if (req.cache === 'no-store') return;
  var name = keyFor(url);
  if (req.mode === 'navigate' || name === '' || name === 'index.html') {
    e.respondWith(
      caches.match('index.html').then(function (hit) {
        var revalidate = fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put('index.html', res.clone()); });
        }).catch(function () {});
        return hit || fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put('index.html', res.clone()); });
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
