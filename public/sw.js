const SHELL_CACHE = "mylms-pocket-shell-v1";
const MEDIA_CACHE = "mylms-pocket-media-v1";

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon-gled.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== MEDIA_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never cache live API / sync / auth endpoints in the Service Worker
  if (
    url.pathname.startsWith("/v1/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  // Media assets (cached course images, audio, video): Cache-First
  if (
    url.pathname.match(/\.(png|jpe?g|gif|webp|svg|mp3|wav|ogg|m4a|mp4|webm)$/i) &&
    !SHELL_ASSETS.includes(url.pathname)
  ) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async (cache) => {
        const cached = await cache.match(request, { ignoreSearch: false });
        if (cached) return cached;
        try {
          const netRes = await fetch(request);
          if (netRes && (netRes.status === 200 || netRes.type === "opaque")) {
            cache.put(request, netRes.clone()).catch(() => {});
          }
          return netRes;
        } catch {
          return new Response("", { status: 504, statusText: "Offline media unavailable" });
        }
      })
    );
    return;
  }

  // App shell navigation & assets: Cache-First with network update in background
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(request.mode === "navigate" ? "/index.html" : request);
      const fetchPromise = fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            cache.put(request.mode === "navigate" ? "/index.html" : request, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
