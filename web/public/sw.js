// Spotted London service worker. Two jobs: open the app when the phone is offline, and load faster.
// It never touches the Worker's own paths (API, sign-in, MCP, server pages), so data is always live.
const SHELL = 'spotted-shell-v1';
const ASSETS = 'spotted-assets-v1';
const MAX_ASSETS = 80;
const WORKER_PATHS = ['/api', '/login', '/mcp', '/privacy', '/llms.txt', '/sw.js'];

// Save the page and the files it loads now, so the very first visit already works offline.
async function precache() {
  const res = await fetch('/', { cache: 'reload' });
  const text = await res.clone().text();
  await (await caches.open(SHELL)).put('/', res);
  const files = [...new Set(text.match(/\/assets\/[^"'\s]+/g) || [])];
  const cache = await caches.open(ASSETS);
  await Promise.all(files.map(f => cache.add(f).catch(() => {})));
}

self.addEventListener('install', event => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== ASSETS).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k);
}

// Pages: network first, so a deploy shows up at once and /p/<slug> keeps the tags the Worker adds for
// search engines. The saved shell is only used when the network fails.
async function page(request) {
  try {
    const res = await fetch(request);
    if (res.ok && request.url === `${self.location.origin}/`) (await caches.open(SHELL)).put('/', res.clone());
    return res;
  } catch {
    return (await caches.match('/')) || Response.error();
  }
}

// /assets/* has a hash in every file name, so a saved copy never goes stale.
async function asset(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // an old file that no longer exists comes back as index.html with status 200: never keep that
  if (res.ok && !(res.headers.get('content-type') || '').includes('text/html')) {
    const cache = await caches.open(ASSETS);
    await cache.put(request, res.clone());
    trim(cache);
  }
  return res;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (WORKER_PATHS.some(p => url.pathname === p || url.pathname.startsWith(`${p}/`))) return;
  if (request.mode === 'navigate') event.respondWith(page(request));
  else if (url.pathname.startsWith('/assets/')) event.respondWith(asset(request));
});
