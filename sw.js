// Offline app shell. Bump VERSION when shipping changes so phones pick them up.
const VERSION = 'aetherstory-v23';
const SHELL = ['./', 'index.html', 'app.js', 'lib.js', 'help.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('aetherstory') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
// Network first so updates land when online; cache when offline. AI calls are cross-origin and untouched.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    // no-cache: revalidate with the server so Pages' 10-minute HTTP cache can't hide a new release.
    fetch(e.request, { cache: 'no-cache' }).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
