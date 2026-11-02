// GitHub Pages serves files as they are — it cannot be given response headers. The Wii engine needs
// SharedArrayBuffer, which the browser only hands out when the document is cross-origin isolated, and
// that needs Cross-Origin-Opener-Policy / Cross-Origin-Embedding-Policy on the document itself. A
// service worker on the same origin can add those two headers to the document response it produces;
// Chrome judges isolation from the response the worker returned. Only navigations are touched, so
// assets (cores, ROMs, art) keep Pages' normal serving and their cache.
const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedding-Policy": "require-corp",
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;      // assets: pass through untouched
  e.respondWith(
    fetch(e.request).then(async (res) => {
      const body = await res.blob();
      const headers = new Headers(res.headers);
      // A rewritten body no longer matches the original byte count or ETag, so the validators that
      // would now be wrong are dropped; caching stays as Pages set it.
      headers.delete("content-length");
      headers.delete("etag");
      for (const [k, v] of Object.entries(ISOLATION)) headers.set(k, v);
      return new Response(body, { status: res.status, statusText: res.statusText, headers });
    }),
  );
});
