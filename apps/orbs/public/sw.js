// Minimal service worker: makes the app installable. It deliberately caches nothing,
// so a deploy is never masked by a stale shell and credentials never reach a cache.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
