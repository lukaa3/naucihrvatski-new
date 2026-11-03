/* Nauči hrvatski — keeps a copy of the app on the device so it opens fast and
   works without internet. Always tries the network first, so updates show up
   straight away; the saved copy is only used when you're offline. */
const CACHE = "nauci-hrvatski-v2";
const CORE = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/favicon-32.png"];
const CDN = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];   // fonts + the sign-in library

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

// (nauci-tts holds the voice clips you've already heard — never thrown away on an update)
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== "nauci-link" && k !== "nauci-tts").map(k => caches.delete(k))))
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

/* ---- notifications ---- */
self.addEventListener("push", e => {
  let m = {};
  try{ m = e.data ? e.data.json() : {}; }catch(err){ m = { title: "Nauči hrvatski", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(m.title || "Nauči hrvatski", {
    body: m.body || "",
    icon: "/icon-192.png",
    badge: "/favicon-32.png",
    tag: m.tag || undefined,
    renotify: !!m.tag,
    data: { url: m.url || "/" }
  }));
});

// Tapping a notification opens the app on the right page (or brings it to the front).
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil((async () => {
    // Leave the link where the app will find it, however it ends up opening
    // (iPhone often resumes the app without passing anything along).
    try{
      const c = await caches.open("nauci-link");
      await c.put("/__pending-link", new Response(JSON.stringify({ url, at: Date.now() }), { headers: { "Content-Type": "application/json" } }));
    }catch(err){}
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find(c => new URL(c.url).origin === self.location.origin);
    if(w){
      try{ await w.focus(); }catch(err){}
      w.postMessage({ type: "open", url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
