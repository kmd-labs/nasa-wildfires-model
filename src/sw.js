const SHELL_CACHE = 'kmd-wildfires-shell-v2';
const TILE_CACHE = 'kmd-wildfires-tiles-v1';
const MAX_CACHED_TILES = 450;

const TILE_HOSTS = new Set([
  'tile.openstreetmap.org',
  'server.arcgisonline.com'
]);

const PRECACHE_REL_URLS = [
  './',
  './index.html',
  './assets/data/calendar-summary.json',
  './assets/data/climate-inertia.json',
  './assets/data/default-iberia-calendar.json',
  './assets/data/enso-history.json',
  './assets/data/timeline-meta.json',
  './assets/data/global-states-10m.json',
  './assets/data/uk-land-10m.json',
  './assets/design-system/favicon.svg'
];

function scopeUrl(relPath) {
  return new URL(relPath, self.registration.scope).toString();
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      await Promise.allSettled(
        PRECACHE_REL_URLS.map(async (rel) => {
          const url = scopeUrl(rel);
          const resp = await fetch(url);
          if (resp.ok) await cache.put(url, resp);
        })
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, TILE_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

async function enforceTileLru(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_CACHED_TILES) return;
  const excess = keys.length - MAX_CACHED_TILES;
  await Promise.all(keys.slice(0, excess).map((req) => cache.delete(req)));
}

async function handleTileRequest(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const networkResp = await fetch(request);
  if (networkResp && networkResp.ok && networkResp.status === 200) {
    cache.put(request, networkResp.clone()).then(() => enforceTileLru(cache)).catch(() => {});
  }
  return networkResp;
}

async function handleShellRequest(request, url) {
  const cache = await caches.open(SHELL_CACHE);
  const isNavigation = request.mode === 'navigate';

  if (isNavigation) {
    try {
      const resp = await fetch(request);
      if (resp && resp.ok) {
        cache.put(request, resp.clone()).catch(() => {});
      }
      return resp;
    } catch {
      return (await cache.match(request)) || (await cache.match(scopeUrl('./index.html'))) || (await cache.match(scopeUrl('./')));
    }
  }

  const cached = await cache.match(request);
  if (cached) {
    // Refresh non-hashed assets in the background
    if (!/\.[a-f0-9]{8,}\.(js|css)$/i.test(url.pathname)) {
      fetch(request).then((resp) => {
        if (resp && resp.ok) cache.put(request, resp.clone());
      }).catch(() => {});
    }
    return cached;
  }

  const resp = await fetch(request);
  if (resp && resp.ok && resp.status === 200) {
    cache.put(request, resp.clone()).catch(() => {});
  }
  return resp;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Backend API responses are managed in IndexedDB by OfflineCacheService
  if (url.pathname.startsWith('/api/') || url.hostname.endsWith('.run.app')) {
    return;
  }

  if (TILE_HOSTS.has(url.hostname)) {
    event.respondWith(handleTileRequest(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(handleShellRequest(request, url));
  }
});
