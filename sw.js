const SW_VERSION = '2026.04.09.2';
const CACHE_NAME = `jp-epub-reader-shell-${SW_VERSION}`;
const APP_SHELL_URLS = ['./', './index.html'];
const NAV_FALLBACK_URL = './index.html';
const CACHE_PREFIX = 'jp-epub-reader-';

function isSuccessfulResponse(response) {
  return !!response && (response.ok || response.type === 'opaque');
}

function toNoStoreRequest(input) {
  return new Request(input, { cache: 'no-store' });
}

async function putInCache(cache, cacheKey, response) {
  if (!isSuccessfulResponse(response)) return response;
  await cache.put(cacheKey, response.clone());
  return response;
}

async function refreshAppShellCache() {
  const cache = await caches.open(CACHE_NAME);
  const results = [];
  for (const url of APP_SHELL_URLS) {
    try {
      const response = await fetch(toNoStoreRequest(url));
      if (isSuccessfulResponse(response)) {
        await cache.put(url, response.clone());
        results.push(true);
      } else {
        results.push(false);
      }
    } catch (error) {
      results.push(false);
    }
  }
  return results.some(Boolean);
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = request.mode === 'navigate' ? NAV_FALLBACK_URL : request;

  try {
    const response = await fetch(toNoStoreRequest(request));
    await putInCache(cache, cacheKey, response);
    if (request.mode === 'navigate') {
      await putInCache(cache, NAV_FALLBACK_URL, response);
    }
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const fallback = await cache.match(NAV_FALLBACK_URL);
    if (fallback && (request.mode === 'navigate' || request.destination === 'document')) {
      return fallback;
    }

    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => putInCache(cache, request, response))
    .catch(() => null);

  if (cached) return cached;

  const fresh = await networkPromise;
  if (fresh) return fresh;

  const fallback = await cache.match(NAV_FALLBACK_URL);
  if (fallback && (request.mode === 'navigate' || request.destination === 'document')) {
    return fallback;
  }

  throw new Error('No cached response available');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await refreshAppShellCache();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
    await refreshAppShellCache().catch(() => null);
  })());
});

self.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (message.type === 'REFRESH_APP_SHELL') {
    event.waitUntil((async () => {
      const ok = await refreshAppShellCache().catch(() => false);
      event.ports?.[0]?.postMessage({ ok });
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isNavigationRequest = request.mode === 'navigate' || request.destination === 'document';
  const isAppShellRequest = isSameOrigin && (url.pathname === self.location.pathname || url.pathname.endsWith('/index.html'));

  if (isNavigationRequest || isAppShellRequest) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
