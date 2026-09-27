var SHELL = "admin-shell-v1", ASSETS = "admin-assets-v1";
self.addEventListener("install", function () { self.skipWaiting() });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== SHELL && k !== ASSETS }).map(function (k) { return caches.delete(k) })) }).then(function () { return self.clients.claim() }));
});
self.addEventListener("message", function (e) {
  if (e.data === "signed-out") e.waitUntil(Promise.all([caches.delete(SHELL), caches.delete(ASSETS)]));
});
var APP_PAGES = { "/admin": 1, "/admin/allowlist": 1, "/admin/analytics": 1 };
self.addEventListener("fetch", function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== self.location.origin) return;
  if (u.pathname.indexOf("/assets/") === 0) {
    e.respondWith(caches.open(ASSETS).then(function (c) {
      return c.match(r).then(function (hit) {
        return hit || fetch(r).then(function (res) {
          if (res.ok && /immutable/.test(res.headers.get("Cache-Control") || "")) {
            c.put(r, res.clone()).then(function () { return c.keys() }).then(function (ks) { ks.slice(0, Math.max(0, ks.length - 40)).forEach(function (k) { c.delete(k) }) });
          }
          return res;
        });
      });
    }));
    return;
  }
  // An admin page opens from its saved copy at once, like an app, and the network copy replaces the saved one for next
  // time (the page reloads itself when a deploy changed it). A signed-out answer (the sign-in page) drops the saved copy,
  // so the next open asks the network. With nothing saved yet it waits for the network.
  if (r.mode === "navigate" && APP_PAGES[u.pathname]) {
    var net = fetch(r).then(function (res) {
      return caches.open(SHELL).then(function (c) {
        if (res.ok && res.headers.get("X-App-Shell")) return c.put(u.pathname, res.clone()).then(function () { return res });
        if (res.status < 500) return c.delete(u.pathname).then(function () { return res });
        return res;
      });
    });
    e.waitUntil(net.catch(function () {}));
    e.respondWith(caches.open(SHELL).then(function (c) { return c.match(u.pathname) }).then(function (hit) { return hit || net }));
  }
});
self.addEventListener("push",function(e){var d={};try{d=e.data.json()}catch(x){d={body:e.data?e.data.text():""}}
e.waitUntil(self.registration.showNotification(d.title||"Hi-Techie",{body:d.body||"",tag:d.tag||undefined,renotify:!!d.tag,icon:"/icon.png",badge:"/icon.png",data:{url:d.url||"/admin"}}))});
self.addEventListener("notificationclick",function(e){e.notification.close();var url=(e.notification.data&&e.notification.data.url)||"/admin";
e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(function(ws){for(var i=0;i<ws.length;i++){var w=ws[i];if(new URL(w.url).pathname.indexOf("/admin")===0){if(w.navigate)w.navigate(url).catch(function(){});return w.focus()}}return self.clients.openWindow(url)}))});
