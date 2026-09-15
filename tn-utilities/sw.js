var CACHE = 'tn-utils-v6';
var PRECACHE = ['index.html', 'style.css', 'parser.js', 'calc.js', 'app.js', 'data/bundle.js', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png',
  'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/chart.umd.js',
  'lib/tesseract.min.js', 'lib/tess_assets.js', 'lib/tess_worker.min.js', 'lib/tesseract-core-simd-lstm.wasm.js'];

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

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  var path = url.pathname;
  var scopePath = new URL(self.registration.scope).pathname;
  var rel = path;
  if (scopePath.length > 1 && path.indexOf(scopePath) === 0) {
    rel = path.slice(scopePath.length);
  }
  if (rel === '' || rel === '/' || rel === 'index.html') {
    e.respondWith(caches.match('index.html').then(function (hit) { return hit || fetch(req); }));
    return;
  }
  e.respondWith(
    caches.match(rel).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(rel, res.clone()); });
        return res;
      });
    })
  );
});