// Cross-origin-isolation shim. Some hosts send COOP/COEP in a way browsers refuse to honour
// (measured on Cloudflare Pages: the headers arrive on the wire, yet window.crossOriginOpenerPolicy
// stays null and crossOriginIsolated stays false). A service worker re-serves each same-origin
// response as a synthetic Response carrying exactly one COOP/COEP pair — browsers do apply those.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function reserve(res, isNavigate) {
  // fetch() already decompressed the body, so the reconstructed response must NOT claim an
  // encoding — keeping content-encoding would make the browser decompress the bytes a second time.
  const h = new Headers(res.headers);
  h.delete("content-encoding");
  h.delete("content-length");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  if (isNavigate) h.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then((res) => reserve(res, e.request.mode === "navigate")));
});
