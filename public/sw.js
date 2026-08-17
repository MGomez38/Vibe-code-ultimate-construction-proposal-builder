/**
 * Crew Portal service worker.
 * Caches the app shell so the portal opens in a basement with no signal.
 * API calls are never cached — portal.js keeps its own data cache in
 * localStorage and queues writes until the phone is back online.
 */
'use strict';

const CACHE = 'dts-portal-v1';
const SHELL = ['/portal', '/css/portal.css', '/js/portal.js', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // never serve stale API data or someone else's session
  if (url.pathname.startsWith('/api/') || url.pathname === '/login') return;

  event.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok && (SHELL.includes(url.pathname) || url.pathname.startsWith('/uploads/'))) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('/portal')))
  );
});
