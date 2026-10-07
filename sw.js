// 電波がなくてもアプリを開けるよう、画面とライブラリを端末に保存する。
// 更新したら VERSION を変える。
const VERSION = "bichiku-v1";
const SHELL = ["./", "index.html", "app.js", "config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const lib = /(^|\.)gstatic\.com$|^fonts\.googleapis\.com$|^cdn\.jsdelivr\.net$/.test(url.hostname);
  if (!sameOrigin && !lib) return; // Firestore・ログイン・商品検索の通信には触れない
  if (sameOrigin) {
    // 自分のファイル：まずネットから最新を取り、だめなら保存分
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res;
    }).catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
  } else {
    // バージョン固定のライブラリ・フォント：保存分を優先
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res;
    })));
  }
});
