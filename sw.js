/* Nauči hrvatski — keeps a copy of the app on the device so it opens fast and
   works without internet. Always tries the network first, so updates show up
   straight away; the saved copy is only used when you're offline. */
const CACHE = "nauci-hrvatski-v2";
const CORE = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/favicon-32.png"];
const CDN = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];   // fonts + the sign-in library

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if(req.method !== "GET") return;
  const url = new URL(req.url);

  // the AI and your account always go straight to the internet — never cached
  if(url.origin === location.origin && url.pathname.startsWith("/api/")) return;

  // fonts and the sign-in library: use the saved copy, refresh it in the background
  if(CDN.includes(url.hostname)){
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if(r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if(url.origin !== location.origin) return;          // anything else (e.g. Supabase) is left alone

  // the app itself: network first; fall back to the saved copy when offline
  const isPage = req.mode === "navigate";
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try{
      const r = await fetch(req);
      if(r && r.ok && !r.redirected) c.put(isPage ? "/" : req, r.clone());
      return r;
    }catch(err){
      const hit = await c.match(isPage ? "/" : req);
      if(hit) return hit;
      throw err;
    }
  })());
});
