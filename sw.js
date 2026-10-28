// Service worker de la app (010-instalacion-webapp): guarda una versión entera de los
// archivos de la app y abre siempre la publicada o, sin conexión, la guardada.
// Rutas relativas a la dirección de este archivo (la carpeta de la app).
importScripts('./logic.js'); // APP_FILES, CONNECTION_TIMEOUT y las funciones de versión (D-4)

const CACHE_PREFIX = 'app-';
const MARK = new URL('./__version__', self.location).href; // marca de versión completa
const PAGE = new URL('./', self.location).href;
// El cuerpo ya viene descomprimido: su tamaño y compresión originales ya no valen
const BODY_HEADERS = ['content-encoding', 'content-length'];
const FILES = APP_FILES.map(file => new URL(file, self.location).href);

// Primera instalación: una versión entera o no se activa (se reintenta al abrir otra vez)
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(installSet());
});

async function installSet() {
  if (await savedVersion()) return; // actualización del propio sw.js: no se baja nada
  for (let attempt = 0; attempt < 3; attempt++) {
    const set = await downloadSet(FILES, 'reload');
    if (!set) continue;
    const check = commonVersion(set.map(file => file.etag));
    if (check.whole) return saveSet(set, check.id);
  }
  throw new Error('No se ha podido guardar una versión entera de la app');
}

// Activación: borra los guardados cortados a medias, sin marca (RF-11)
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    for (const name of await appCaches()) {
      const cache = await caches.open(name);
      if (!(await cache.match(MARK))) await caches.delete(name);
    }
  })());
});

// Solo la página de la app y sus archivos; Supabase y todo lo demás, sin tocar (RNF-1)
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (isAppPage(request.url, self.registration.scope)) event.respondWith(openApp());
    return;
  }
  if (FILES.includes(request.url)) event.respondWith(fromSaved(request));
});

// La página: la publicada si hay red; si no, o si Pages está a medias, la guardada (RF-9, RF-13, CL-1, CL-2)
async function openApp() {
  const saved = await savedVersion();
  const index = await download(PAGE, 'no-cache');
  if (!index) return saved ? savedPage(saved) : Response.error(); // CL-4: página de error del navegador
  const publishedId = etagVersion(index.etag);
  if (saved && isSavedCurrent(saved.id, publishedId)) return savedPage(saved);
  const rest = await downloadSet(FILES.filter(url => url !== PAGE), 'no-cache');
  if (!rest) return saved ? savedPage(saved) : toResponse(index); // corte a medias (RF-11)
  const set = [index, ...rest];
  const check = commonVersion(set.map(file => file.etag));
  if (!check.whole) return saved ? savedPage(saved) : toResponse(index); // CL-2
  await saveSet(set, check.id);
  return toResponse(index);
}

// Un archivo de la app: de la versión guardada, que es la de la página servida (D-2, CL-3)
async function fromSaved(request) {
  const saved = await savedVersion();
  const response = saved && await saved.cache.match(request.url);
  return response || fetch(request);
}

// Descarga todos a la vez y lee cada cuerpo entero antes de guardar nada; null si falla uno
async function downloadSet(urls, cacheMode) {
  const set = await Promise.all(urls.map(url => download(url, cacheMode)));
  return set.every(Boolean) ? set : null;
}

// Un archivo: plazo de CONNECTION_TIMEOUT hasta las cabeceras; el cuerpo se espera (3G lento)
async function download(url, cacheMode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT);
  try {
    const response = await fetch(url, { cache: cacheMode, signal: controller.signal });
    clearTimeout(timer);
    if (response.status !== 200) return null;
    return {
      url,
      etag: response.headers.get('ETag'),
      headers: [...response.headers].filter(([name]) => !BODY_HEADERS.includes(name)),
      body: await response.arrayBuffer(),
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function toResponse(file) {
  return new Response(file.body, { status: 200, headers: file.headers });
}

// Guardados de uno en uno: dos cargas a la vez se borrarían mutuamente su copia en curso (RF-11)
let saving = Promise.resolve();

function saveSet(set, id) {
  const run = saving.then(() => saveWhole(set, id));
  saving = run.catch(() => {});
  return run;
}

// Guarda la versión entera, la marca la última y sustituye a las anteriores (RF-11)
async function saveWhole(set, id) {
  const name = CACHE_PREFIX + (id ?? 'local-' + Date.now());
  const cache = await caches.open(name);
  for (const file of set) await cache.put(file.url, toResponse(file));
  await cache.put(MARK, new Response(id ?? ''));
  for (const other of await appCaches()) {
    if (other !== name) await caches.delete(other);
  }
}

// La versión guardada completa (con marca): { id, cache } o null
async function savedVersion() {
  for (const name of await appCaches()) {
    const cache = await caches.open(name);
    const mark = await cache.match(MARK);
    if (mark) return { id: (await mark.text()) || null, cache };
  }
  return null;
}

async function savedPage(saved) {
  return (await saved.cache.match(PAGE)) || Response.error();
}

async function appCaches() {
  return (await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX));
}
