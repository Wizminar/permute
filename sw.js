// Offline support: the app shell is cached on install, the conversion
// libraries are cached in the background, and libraries are served
// cache-first while app code is network-first. Bump VERSION when vendor files change.
const VERSION = 'permute-v2.3.0';

const SHELL = [
  './',
  'index.html',
  'assets/app.css',
  'assets/logo.svg',
  'favicon.svg',
  'assets/fonts/ibm-plex-sans-latin-400-normal.woff2',
  'assets/fonts/ibm-plex-sans-latin-500-normal.woff2',
  'assets/fonts/ibm-plex-sans-latin-600-normal.woff2',
  'assets/fonts/ibm-plex-mono-latin-400-normal.woff2',
  'assets/fonts/ibm-plex-mono-latin-500-normal.woff2',
  'favicon.ico',
  'manifest.webmanifest',
  'js/theme.js',
  'js/app.js',
  'js/util.js',
  'js/formats.js',
  'js/convert.js',
  'js/engines/image.js',
  'js/engines/pdf.js',
  'js/engines/document.js',
  'js/engines/data.js',
  'js/engines/media.js',
];

const LIBRARIES = [
  "vendor/docx.iife.js",
  "vendor/fflate.mjs",
  "vendor/gifenc.mjs",
  "vendor/libheif.mjs",
  "vendor/js-yaml.min.mjs",
  "vendor/mammoth.min.js",
  "vendor/marked.mjs",
  "vendor/mediabunny.min.mjs",
  "vendor/mp3-encoder.min.mjs",
  "vendor/pdf-lib.min.mjs",
  "vendor/pdf.min.mjs",
  "vendor/pdf.worker.min.mjs",
  "vendor/purify.mjs",
  "vendor/turndown.mjs",
  "vendor/utif.js",
  "vendor/xlsx.full.min.js",
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // Libraries are large; fetch them without blocking install.
    cache.addAll(LIBRARIES).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Libraries and fonts never change under the same name: cache first.
  // App code: network first so updates show up, cache when offline.
  const immutable = /\/(vendor|assets\/fonts)\//.test(url.pathname);
  event.respondWith(immutable ? cacheFirst(request) : networkFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
    throw err;
  }
}
