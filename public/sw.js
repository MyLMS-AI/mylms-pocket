const CACHE_NAME = "mylms-pocket-shell-v3";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/logo-mylms-dark.png",
  "/logo-mylms-light.png",
  "/favicon-mylms-dark.png",
  "/bg-hero-dark.png",
  "/dots.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
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
            .filter((k) => k.startsWith("mylms-pocket-shell-") && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put("/index.html", clone)).catch(() => {});
          return res;
        })
        .catch(async () => {
          const cached = await caches.match("/index.html");
          return cached || caches.match("/");
        })
    );
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          return new Response(JSON.stringify({ offline: true, items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((netRes) => {
          if (netRes && (netRes.status === 200 || netRes.type === "opaque")) {
            const clone = netRes.clone();
            caches.open("mylms-pocket-media-v1").then((c) => c.put(req, clone)).catch(() => {});
          }
          return netRes;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
