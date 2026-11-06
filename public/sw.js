// Keeps the app and the photos on the device (only where the browser allows it: localhost or https).
// On the wifi address (http://192.168…) browsers refuse service workers: the server's cache headers do the job there.
const V = 'rabbit-pos-2';
const SHELL = ['/', '/pos.html', '/pos.css', '/pos.js', '/manifest.webmanifest', '/menu.html', '/menu.css', '/menu.js', '/img/logo-mark-white.png', '/img/logo-name-white.png',
  '/fonts/nunito-latin-400-normal.woff2', '/fonts/nunito-latin-700-normal.woff2', '/fonts/nunito-latin-800-normal.woff2',
  '/fonts/baloo-2-latin-700-normal.woff2', '/fonts/baloo-2-latin-800-normal.woff2'];

self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // live data: always the server
  if (url.pathname.startsWith('/photos/')) {   // a photo never changes under the same name
    e.respondWith(caches.open(V).then(async c => (await c.match(e.request)) || fetch(e.request).then(r => (r.ok && c.put(e.request, r.clone()), r))));
    return;
  }
  // App files: answer at once from the device, refresh in the background for next time.
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then(r => (r.ok && c.put(e.request, r.clone()), r)).catch(() => hit);
    return hit || net;
  }));
});
