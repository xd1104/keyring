/* 鑰匙圈啟動頁的 service worker（2026-08-28）
 * ------------------------------------------------------------------
 * 只做一件事：**把啟動頁那四個檔案存起來，斷網也打得開**。
 * 沒有它的話，「離線也點得開」只有在瀏覽器剛好還留著 HTTP 快取時才成立 ——
 * 而「加到主畫面」之後在飛航模式打開，很容易就是一片白。
 *
 * ⚠️ 它註冊在 repo 根目錄，所以 scope 涵蓋整個 /keyring/（含手機後台 /keyring/web/）。
 *    因此 fetch 攔截**只處理下面那份清單裡的檔案**，其餘一律不呼叫 respondWith()
 *    ——瀏覽器就照它原本的方式去拿，後台的行為一個位元組都不會變。
 * ⚠️ apps.json 刻意**不快取**：那份清單的離線備援是 localStorage（launch.js 自己管），
 *    兩套快取只會讓「他看到的是哪一份」變成猜謎。
 * ⚠️ 改了啟動頁的檔案要把 CACHE 的版本號 +1，否則舊的會一直被端出來。
 */
var CACHE = "keyring-launch-v1";
var SHELL = ["./", "./index.html", "./launch/launch.css", "./launch/launch.js", "./client/keyring-fields.js"];

function shellUrls() {
  return SHELL.map(function (p) { return new URL(p, self.registration.scope).href; });
}

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL);
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var urls = shellUrls();
  var url = req.url.split("?")[0];
  if (urls.indexOf(url) < 0) return;          /* 不是啟動頁的殼就完全不插手 */
  /* 先給快取（開得快、離線也開得起來），背景再更新成最新的 */
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});
