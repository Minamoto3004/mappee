/* Mappee — service worker : coquille hors ligne + données en cache.
   Stratégies :
   - coquille (index, vendor, icônes, manifest) : cache d'abord, mise à jour en arrière-plan
   - data/toilets.geojson : réseau d'abord (fraîcheur), cache en secours
   - tuiles/style IGN : cache opportuniste borné (~200 entrées)
   - API signalements (workers.dev) : réseau uniquement, jamais de cache */

const VERSION = "mappee-v1";
const SHELL = [
  "./",
  "./index.html",
  "./vendor/maplibre-gl.js",
  "./vendor/maplibre-gl.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];
const TILE_CACHE = VERSION + "-tiles";
const TILE_MAX = 200;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![VERSION, TILE_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;                       // POST signalements : réseau direct
  if (url.hostname.endsWith("workers.dev")) return;             // état des avis : toujours frais

  // données : réseau d'abord, cache en secours
  if (url.pathname.endsWith("/data/toilets.geojson")) {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // fond de carte IGN : cache opportuniste borné
  if (url.hostname === "data.geopf.fr") {
    e.respondWith(
      caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(TILE_CACHE).then((c) => c.put(e.request, copy)).then(() => trimCache(TILE_CACHE, TILE_MAX));
        }
        return r;
      }))
    );
    return;
  }

  // la page elle-même : réseau d'abord (tes mises à jour arrivent), cache en secours
  if (e.request.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
        .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match("./index.html")))
    );
    return;
  }

  // reste de la coquille (vendor, icônes — versionnés de fait) : cache d'abord
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return r;
      }))
    );
  }
});
