"use strict";
/*
 * keyring-unlock.js — 鑰匙圈解鎖模組（可重用，複製到各 App 的前端就能用）
 *
 * 它做什麼：
 *   到公開的鑰匙圈 repo 抓 keyring.json（裡面只有密文），讓使用者選自己、輸密碼，
 *   在瀏覽器裡用 WebCrypto 解出這個 App 的 GitHub 金鑰，寫進該 App 既有的 localStorage key。
 *   密碼錯 = AES-GCM 驗證失敗（沒有伺服器可以驗，也不需要存密碼 hash）。
 *
 * 別的 App 要用：把這一個檔案複製過去（自帶樣式、零依賴），然後
 *   Keyring.init({ appId:"你的 App id", tokenKey:"你原本存金鑰的 localStorage key",
 *                  onChange:function(){ 重新載入資料並重繪 }, toast:你的 toast });
 *   footer 放 Keyring.chipHtml()；寫入守門處呼叫 Keyring.open("動作名")；
 *   首頁畫完呼叫一次 Keyring.maybeIntro()。
 *
 * ── 解鎖畫面 v3「公版」（2026-08-20，Benson 拍板）──────────────────────────────
 *   解鎖是「進 App 之前」的一層，不屬於任何一個 App 的視覺語言 —— 所以它是
 *   **滿版暖墨深色**，而且**每個 App 長得一模一樣**（同一份 computed style）。
 *   ⚠️ 顏色歸屬鐵律（這是根治「半套主題化」的規則本身）：
 *     1. `#kr-full` 子樹內**一個宿主變數都不准讀**，連 `var(--acc, fallback)` 都不行
 *        （fallback 一樣會造成「一半吃變數、一半寫死」）。模組自己的常數用 `--krs-*`。
 *     2. 唯一的例外是**身分藥丸 `.kr-chip`**（它住在 App 的畫面裡）：
 *        主色只准上**前景**（`.kr-cta` 的文字色），**底色永遠是模組固定的中性色**。
 *        新 App 接進來什麼都不用設；想讓「點我解鎖」跟著 App 走就設一個 `--acc`。
 *   加解密參數與 keyring/server.js 是同一套，改要兩邊一起改。
 */
(function (global) {
  var DEFAULT_URL = "https://raw.githubusercontent.com/xd1104/keyring/main/keyring.json";

  var CFG = {
    appId: "",
    tokenKey: "",
    url: DEFAULT_URL,
    ns: "",                 /* 本機記憶的 key 前綴，預設 keyring.<appId>. */
    enabled: true,
    introDelay: 900,
    appName: "",            /* 滿版左上角顯示的 App 名字；沒給就用 document.title（零設定） */
    onChange: null,         /* function(state) 解鎖／換人／金鑰更新後呼叫 */
    toast: null,            /* function(msg, isErr) 借用 App 自己的 toast */
    /* 一個人一個顏色（跨 App 都是同一個顏色）。
     * v3 起頭像改回**滿彩度＋圓形**：滿版是深底，需要彩度才看得見人；
     * 而且「圓形＝人、圓角矩形＝內容（旅程／菜色）」用形狀分語意，顏色就不必退讓。
     * （v2.1 曾把它壓成 20% tint，那是因為當時解鎖 sheet 疊在旅程封面旁邊會撞；
     *   v3 的滿版層畫面上根本沒有封面可以撞 —— 這是刻意反轉，別當 bug 修回去。） */
    themes: {
      sunset: "linear-gradient(135deg,#ff8a80,#ff5f7e 55%,#c94b9d)",
      ocean:  "linear-gradient(135deg,#38c3a7,#2f8fd6)",
      night:  "linear-gradient(135deg,#6a7bf0,#8e54c9)",
      forest: "linear-gradient(135deg,#7ec96f,#3f9d8a)",
      sand:   "linear-gradient(135deg,#f5c65d,#f0855c)"
    }
  };

  var ring = null;          /* 抓回來的 keyring.json */
  var ringErr = "";
  var loading = null;       /* 抓取中的 promise */
  var device = null;        /* {userId,name,emoji,theme,at,k,t,remember} */
  var started = false;
  var layer = null;
  var prevOverflow = null;  /* 開滿版前宿主的 body overflow，關掉時原樣還回去 */
  var ui = { step: "who", userId: null, reason: "", tries: 0, busy: false, show: false, remember: true, open: false };

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function grad(t) { return CFG.themes[t] || CFG.themes.sunset; }
  function appLabel() { return CFG.appName || (document && document.title) || ""; }
  function say(msg, isErr) { if (typeof CFG.toast === "function") { try { CFG.toast(msg, isErr); } catch (e) { } } }
  function b64ToBytes(b64) {
    var bin = atob(String(b64 || "").replace(/\s/g, ""));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { } }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) { } }
  function K(name) { return CFG.ns + name; }

  /* ---------------- 加解密（WebCrypto；需要 https 或 localhost） ---------------- */
  function subtle() {
    var c = global.crypto || (typeof crypto !== "undefined" ? crypto : null);
    return c && c.subtle ? c.subtle : null;
  }
  function deriveKey(password, saltB64, iter) {
    var s = subtle();
    if (!s) return Promise.reject(new Error("這個瀏覽器不支援解密（需要 https）"));
    return s.importKey("raw", new TextEncoder().encode(String(password)), { name: "PBKDF2" }, false, ["deriveKey"])
      .then(function (base) {
        return s.deriveKey(
          { name: "PBKDF2", salt: b64ToBytes(saltB64), iterations: iter || 600000, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
      });
  }
  function decryptEntry(key, entry) {
    var s = subtle();
    return s.decrypt({ name: "AES-GCM", iv: b64ToBytes(entry.iv) }, key, b64ToBytes(entry.cipher))
      .then(function (buf) { return new TextDecoder().decode(buf); });
  }
  function exportKey(key) { return subtle().exportKey("raw", key).then(function (b) { return bytesToB64(b); }); }
  function importKey(b64) {
    return subtle().importKey("raw", b64ToBytes(b64), { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
  }

  /* ---------------- 鑰匙圈讀取 ---------------- */
  /* 每次要用的時候都重新抓（Benson 剛在後台加了人，這邊不重整也要看得到）。
   * 只用很短的 TTL 擋連點狂打；**失敗絕對不快取**，下次開 sheet 要能重試。 */
  var ringAt = 0;
  var RING_TTL = 4000;   /* 只用來擋連點狂打，別長到「他說設好了但還是看不到」 */
  function fetchRing(force) {
    if (!force && ring && (Date.now() - ringAt) < RING_TTL) return Promise.resolve(ring);
    if (loading) return loading;   /* 同一輪抓取共用，別開一堆重複請求 */
    /* raw CDN 會快取好幾分鐘 -> 一定要加 cache-buster */
    var url = CFG.url + (CFG.url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
    loading = fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("拿不到鑰匙圈（" + r.status + "）");
      return r.json();
    }).then(function (j) {
      ring = j && Array.isArray(j.users) ? j : { version: 1, apps: [], users: [] };
      ringAt = Date.now();
      ringErr = "";
      loading = null;
      return ring;
    }).catch(function (e) {
      ringErr = (e && e.message) || "拿不到鑰匙圈";
      ring = null;
      ringAt = 0;
      loading = null;           /* 失敗不留快取，下次再抓一次 */
      throw e;
    });
    return loading;
  }
  function ringUsers() {
    if (!ring) return [];
    /* 只列得到這個 App 鑰匙的人（沒勾這個 App 的人列出來也解不開東西） */
    return ring.users.filter(function (u) { return u.apps && u.apps[CFG.appId]; });
  }
  function ringUser(id) {
    var list = ring ? ring.users : [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  /* 同名的人怎麼分辨（純前端，不動後台也不動資料格式）：
   *   後台有填 hint（選填欄位）就用 hint；沒有、但名字在這個 App 的名單裡重複，
   *   就退而顯示 id（ASCII slug，本來就唯一）。名字不重複又沒 hint 就不顯示。 */
  function hintOf(u) {
    if (!u) return "";
    if (u.hint) return u.hint;
    var dup = ringUsers().filter(function (x) { return x.name === u.name; }).length > 1;
    return dup ? (u.id || "") : "";
  }

  /* ---------------- 裝置記憶 ---------------- */
  function readDevice() {
    var raw = ssGet(K("device")) || lsGet(K("device"));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function writeDevice(d) {
    device = d;
    var json = JSON.stringify(d);
    if (d.remember) { lsSet(K("device"), json); ssDel(K("device")); }
    else { ssSet(K("device"), json); lsDel(K("device")); }
    writeToken(d.t, d.remember);
  }
  function writeToken(token, remember) {
    if (!CFG.tokenKey) return;
    if (remember) { lsSet(CFG.tokenKey, token); ssDel(CFG.tokenKey); }
    else { ssSet(CFG.tokenKey, token); lsDel(CFG.tokenKey); }
  }
  function forget() {
    device = null;
    lsDel(K("device")); ssDel(K("device"));
    if (CFG.tokenKey) { lsDel(CFG.tokenKey); ssDel(CFG.tokenKey); }
  }

  /* 每次載入都拿目前的鑰匙圈對一次：
   *   人被刪／這個 App 被收回  -> 清掉，回到只看看
   *   密碼被換掉（金鑰解不開）  -> 清掉，回到只看看
   *   只是換了金鑰（PAT 換新）  -> 用記著的金鑰解出新的，自動換過去、不用重解鎖
   * 抓不到鑰匙圈（離線）時什麼都不動，維持現狀。 */
  function refreshFromRing() {
    if (!device) return Promise.resolve();
    return fetchRing(true).then(function () {
      var u = ringUser(device.userId);
      var entry = u && u.apps ? u.apps[CFG.appId] : null;
      if (!u || !entry) {
        forget();
        say("鑰匙圈更新過了，這台裝置回到只看看");
        notify();
        return;
      }
      /* 顯示用的資料（名字／emoji／顏色）在後台改過就跟著換。
       * 解鎖時存的是當下的快照，不回頭對的話後台改名這邊永遠是舊的。
       * 金鑰完全不動，所以不用重新輸密碼。 */
      if (device.name !== u.name || device.emoji !== u.emoji || device.theme !== u.theme) {
        device.name = u.name;
        device.emoji = u.emoji;
        device.theme = u.theme;
        writeDevice(device);
        notify();
      }
      if (!device.k) return;
      return importKey(device.k)
        .then(function (key) { return decryptEntry(key, entry); })
        .then(function (token) {
          if (token && token !== device.t) {
            device.t = token;
            writeDevice(device);
            notify();
          }
        })
        .catch(function () {
          forget();
          say("鑰匙換過了，要用新密碼再解一次");
          notify();
        });
    }).catch(function () { /* 離線：維持現狀 */ });
  }
  function notify() { if (typeof CFG.onChange === "function") { try { CFG.onChange(publicState()); } catch (e) { } } }
  function publicState() {
    return device ? { unlocked: true, userId: device.userId, name: device.name, emoji: device.emoji, theme: device.theme }
      : { unlocked: false };
  }

  /* ---------------- 樣式（只注入一次） ----------------
   * ⚠️ 這份 CSS 是「注入到別人家的 App」裡跑的，宿主自己就有一整套 CSS。權重規則：
   *   ・滿版層內：一律 `#kr-full .kr-x{}`（1,1,0）——綁的是**模組自己的 id**，
   *     不是宿主結構，複製到任何 App 都成立，而且壓得過宿主任何 class 選擇器。
   *   ・滿版層外（只有身分藥丸）：`.kr-chip.kr-chip{}`（0,2,0），同一個 class 寫兩次。
   *   ・**絕對禁止** `.home-foot .kr-chip`／`#app .kr-chip` 這種綁宿主 DOM 的寫法
   *     —— 那樣下一個複製這個檔案的 App 又會壞一次。
   * 血淚：v2.0 的解鎖鈕被自己的 `.kr-sheet button` 通則壓成透明、footer 藥丸被
   *      travel-book 的 `.home-foot button` 壓成灰色小字。 */
  var CSS = ''
    /* ── 滿版容器：所有顏色都是模組自己的常數（--krs-*），一個宿主變數都不讀 ── */
    + '#kr-full{position:fixed; left:0; top:0; right:0; z-index:99999;'
    + ' height:100dvh; height:var(--kr-vh,100dvh);'
    + ' display:flex; flex-direction:column;'
    + ' --krs-ink:#f7f2e8; --krs-mut:#a49a8c; --krs-line:rgba(255,255,255,.12);'
    + ' --krs-face:rgba(255,255,255,.055); --krs-facehi:rgba(255,255,255,.10);'
    + ' --krs-btn:#f6efe1; --krs-btn-ink:#241e17;'
    + ' --krs-err-bg:rgba(255,120,105,.14); --krs-err-line:rgba(255,120,105,.30); --krs-err-ink:#ffb3a6;'
    + ' --krs-warn-bg:rgba(255,198,120,.13); --krs-warn-line:rgba(255,198,120,.28); --krs-warn-ink:#f2d5a1;'
    /* 刻意不做到 100% 不透明：後面的 App 還看得到形狀但看不清細節 ⇒「你沒有離開 App」。
     * 不支援 backdrop-filter 的瀏覽器就是一片暖墨底，不會壞。 */
    + ' background:rgba(26,21,16,.955); -webkit-backdrop-filter:blur(18px); backdrop-filter:blur(18px);'
    + ' color:var(--krs-ink);'
    + ' font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;'
    + ' font-size:15px; line-height:1.5; letter-spacing:normal; text-align:left;'
    /* ⬇ 把「會被繼承」的屬性全部鎖死。這是跟「權重被壓」不同的第二條滲漏路徑：
     * 宿主在 html/body/`*` 上設的繼承屬性會直接流進來，選擇器權重擋不住它（因為模組根本沒宣告）。
     * 實測抓到的：travel 有 `-webkit-tap-highlight-color:transparent`、recipe 沒有
     * ⇒ 同一顆頭像磚在 iPhone 上一個 App 點下去會閃灰、另一個不會；`text-size-adjust` 也是 auto vs 100%。
     * 公版的定義是「兩個 App 逐項相同」，所以這裡寧可寫多也不要漏。 */
    + ' box-sizing:border-box; -webkit-tap-highlight-color:transparent;'
    + ' -webkit-text-size-adjust:100%; text-size-adjust:100%;'
    + ' font-weight:400; font-style:normal; font-variant:normal; font-variant-numeric:normal;'
    + ' font-stretch:normal; text-transform:none; text-indent:0; text-shadow:none;'
    + ' word-spacing:normal; white-space:normal; word-break:normal; overflow-wrap:normal;'
    + ' direction:ltr; cursor:default; visibility:visible; list-style:none; tab-size:4; hyphens:manual;'
    + ' -webkit-font-smoothing:auto; -moz-osx-font-smoothing:auto;'
    + ' -webkit-touch-callout:default; -webkit-user-select:auto; user-select:auto;'
    + ' animation:kr-in .24s cubic-bezier(.2,.8,.3,1);}'
    + '#kr-full[hidden]{display:none;}'
    /* 頂部一層極淡暖光：跟各 App 的暖米白是同一個色溫的兩端（白天／關燈） */
    + '#kr-full::before{content:""; position:absolute; inset:0; pointer-events:none;'
    + ' background:radial-gradient(120% 70% at 50% -14%, rgba(255,203,140,.16), rgba(255,203,140,0) 62%);}'
    + '@keyframes kr-in{from{opacity:0; transform:scale(1.02);} to{opacity:1; transform:none;}}'
    + '@keyframes kr-sp{to{transform:rotate(360deg);}}'
    + '#kr-full *{box-sizing:border-box;}'
    + '#kr-full button{font-family:inherit; font-size:15px; border:none; background:none; cursor:pointer;'
    + ' color:inherit; padding:0; margin:0; line-height:1.4; text-align:inherit;'
    + ' -webkit-appearance:none; appearance:none; box-shadow:none;}'
    /* checkbox 雖然是視覺隱藏的（1×1 透明），font-size 還是會被宿主的 `input{}` 決定
     * ⇒ 兩個 App 量到 13.33px vs 16px。一律鎖 16px（順便符合 iOS 不自動放大那條）。 */
    + '#kr-full input{font-family:inherit; font-size:16px; font-weight:400; line-height:normal;'
    + ' letter-spacing:normal; -webkit-appearance:none; appearance:none;}'
    /* ── 上／中／下三段：全篇不用 position:fixed 的子元素 ──
     * 鍵盤彈出時 .kr-foot 自然停在鍵盤正上方。這是刻意的，不要「優化」成 fixed。 */
    + '#kr-full .kr-top{flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; gap:10px;'
    + ' width:100%; max-width:1120px; margin:0 auto; position:relative; z-index:1;'
    + ' padding:calc(10px + env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) 4px max(14px, env(safe-area-inset-left));}'
    + '#kr-full .kr-app{font-size:13px; font-weight:700; color:var(--krs-mut); white-space:nowrap;'
    + ' overflow:hidden; text-overflow:ellipsis;}'
    + '#kr-full .kr-back{min-height:44px; padding:0 12px 0 0; font-size:14.5px; font-weight:700;'
    + ' color:var(--krs-mut); display:inline-flex; align-items:center;}'
    + '#kr-full .kr-x{min-width:46px; min-height:46px; font-size:19px; color:var(--krs-mut); flex:0 0 auto;'
    + ' border-radius:99px; display:flex; align-items:center; justify-content:center;}'
    + '#kr-full .kr-x:hover{background:var(--krs-face); color:var(--krs-ink);}'
    + '#kr-full .kr-main{flex:1 1 auto; overflow-y:auto; -webkit-overflow-scrolling:touch; position:relative; z-index:1;'
    + ' display:flex; flex-direction:column;}'
    /* flex:1 0 auto ⇒ 內容短時垂直置中、內容長時撐開可捲、不會截頂 */
    + '#kr-full .kr-mid{flex:1 0 auto; display:flex; align-items:center; justify-content:center;'
    + ' padding:6px max(18px, env(safe-area-inset-right)) 18px max(18px, env(safe-area-inset-left));}'
    + '#kr-full .kr-wrap{width:100%; max-width:560px;}'
    + '#kr-full .kr-wrap.narrow{max-width:380px;}'
    + '#kr-full .kr-foot{flex:0 0 auto; border-top:1px solid var(--krs-line); position:relative; z-index:1;'
    + ' padding:0 max(14px, env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left));}'
    /* ── 標題區 ── */
    + '#kr-full .kr-h{font-size:25px; font-weight:800; margin:0 0 6px; letter-spacing:-.2px; color:var(--krs-ink);}'
    + '#kr-full .kr-sub{font-size:14.5px; color:var(--krs-mut); margin:0 0 18px; line-height:1.6;}'
    + '#kr-full .kr-why{background:var(--krs-facehi); border:1px solid var(--krs-line); color:var(--krs-ink);'
    + ' font-size:13.5px; font-weight:600; border-radius:13px; padding:11px 14px; margin:0 0 16px; line-height:1.55;}'
    /* ── 選人磚：圓形頭像＝人（跟 App 裡圓角矩形的旅程／菜色卡分得開） ── */
    + '#kr-full .kr-grid{display:flex; flex-wrap:wrap; gap:10px; justify-content:center;}'
    + '#kr-full .kr-tile{flex:0 0 calc(50% - 5px); min-height:126px; display:flex; flex-direction:column;'
    + ' align-items:center; justify-content:center; gap:9px; padding:14px 10px; border-radius:18px;'
    + ' background:var(--krs-face); border:1px solid var(--krs-line); color:var(--krs-ink); text-align:center;'
    + ' transition:background .14s, transform .14s;}'
    + '#kr-full .kr-tile:hover{background:var(--krs-facehi);}'
    + '#kr-full .kr-tile:active{transform:scale(.97);}'
    + '#kr-full .kr-grid.many .kr-tile{flex:0 0 calc(33.333% - 7px); min-height:112px;}'
    + '#kr-full .kr-grid.many .kr-av{width:54px; height:54px; font-size:25px;}'
    + '#kr-full .kr-av{width:66px; height:66px; border-radius:50%; display:flex; align-items:center;'
    + ' justify-content:center; font-size:30px; line-height:1; flex:0 0 auto;'
    + ' box-shadow:0 2px 10px rgba(0,0,0,.18), inset 0 0 0 1px rgba(255,255,255,.16);}'
    + '#kr-full .kr-tx{display:block; width:100%; min-width:0;}'
    + '#kr-full .kr-nm{font-size:14.5px; font-weight:700; line-height:1.35; max-width:100%;'
    + ' overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; word-break:break-word;}'
    + '#kr-full .kr-hint{display:block; font-size:11.5px; font-weight:500; color:var(--krs-mut); margin-top:3px;'
    + ' white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;}'
    /* ── 「先看看就好」＝畫面第二個焦點，不是角落小連結。每一屏都要有。 ── */
    + '#kr-full .kr-peek{display:block; width:100%; min-height:62px; padding:10px 14px; border-radius:14px;'
    + ' text-align:center; color:var(--krs-ink);}'
    + '#kr-full .kr-peek:hover{background:var(--krs-face);}'
    + '#kr-full .kr-peek b{display:block; font-size:15.5px; font-weight:700;}'
    + '#kr-full .kr-peek span{display:block; font-size:12.5px; color:var(--krs-mut); margin-top:2px;}'
    /* ── 身分列（輸密碼／已解鎖） ── */
    /* ⚠️ 副標一定要寫成 `.kr-id div span`（1,1,2）而不是 `.kr-id span`（1,1,1）：
     * 頭像本身也是 .kr-id 底下的 <span>，寫成後者會壓過 `#kr-full .kr-av`（1,1,0），
     * 66px 的圓頭像就會變成 13.5px 灰字、emoji 縮在左上角。（demo 有這個洞，實測抓到） */
    + '#kr-full .kr-id{display:flex; flex-direction:column; align-items:center; text-align:center; gap:10px; margin:0 0 20px;}'
    + '#kr-full .kr-id b{display:block; font-size:21px; font-weight:800;}'
    + '#kr-full .kr-id div span{display:block; font-size:13.5px; color:var(--krs-mut); margin-top:4px;}'
    /* ── 密碼欄（font-size 16px：iOS 才不會自動放大） ── */
    + '#kr-full .kr-field{display:block; position:relative; margin:0 0 12px;}'
    + '#kr-full .kr-field input{width:100%; min-height:54px; font-size:16px; font-weight:500; line-height:normal;'
    + ' padding:0 56px 0 16px; margin:0; border-radius:14px; border:1px solid var(--krs-line);'
    + ' background:var(--krs-face); color:var(--krs-ink); outline:none; box-shadow:none;}'
    + '#kr-full .kr-field input::placeholder{color:var(--krs-mut); opacity:1;}'
    + '#kr-full .kr-field input:focus{border-color:rgba(255,255,255,.45); background:var(--krs-facehi);}'
    + '#kr-full .kr-eye{position:absolute; right:3px; top:50%; transform:translateY(-50%); width:48px; height:48px;'
    + ' display:flex; align-items:center; justify-content:center; font-size:17px; border-radius:12px;}'
    + '#kr-full .kr-err{background:var(--krs-err-bg); border:1px solid var(--krs-err-line); color:var(--krs-err-ink);'
    + ' font-size:13.5px; font-weight:700; border-radius:13px; padding:11px 14px; margin:0 0 12px; line-height:1.5;}'
    + '#kr-full .kr-err span{display:block; font-weight:500; font-size:12.5px; margin-top:4px; opacity:.85;}'
    + '#kr-full .kr-warn{background:var(--krs-warn-bg); border:1px solid var(--krs-warn-line); color:var(--krs-warn-ink);'
    + ' font-size:13.5px; border-radius:14px; padding:12px 14px; margin:0 0 16px; line-height:1.6;}'
    /* ── 勾選 ── */
    + '#kr-full .kr-check{display:flex; align-items:center; gap:11px; min-height:50px; margin:0; cursor:pointer;'
    + ' position:relative; text-align:left;}'
    + '#kr-full .kr-check input{position:absolute; opacity:0; width:1px; height:1px; margin:0;}'
    + '#kr-full .kr-box{width:26px; height:26px; border-radius:8px; border:1.5px solid var(--krs-mut);'
    + ' background:transparent; flex:0 0 auto; display:flex; align-items:center; justify-content:center;'
    + ' font-size:15px; color:var(--krs-btn-ink); line-height:1;}'
    + '#kr-full .kr-check input:checked + .kr-box{background:var(--krs-btn); border-color:var(--krs-btn);}'
    + '#kr-full .kr-check input:checked + .kr-box::after{content:"\\2713";}'
    + '#kr-full .kr-lb{font-size:15px; font-weight:600;}'
    + '#kr-full .kr-lb small{display:block; font-size:12.5px; color:var(--krs-mut); font-weight:500;'
    + ' margin-top:2px; line-height:1.5;}'
    /* ── 按鈕：主鈕是暖白底＋深字，刻意不是珊瑚／橘（那是 App 的顏色，這一層沒有） ── */
    + '#kr-full .kr-go{width:100%; min-height:54px; border-radius:15px; background:var(--krs-btn);'
    + ' color:var(--krs-btn-ink); font-size:16.5px; font-weight:800; display:flex; align-items:center;'
    + ' justify-content:center; gap:9px; margin-top:6px;}'
    + '#kr-full .kr-go[disabled]{opacity:.66;}'
    + '#kr-full .kr-ghost{width:100%; min-height:54px; border-radius:15px; border:1px solid var(--krs-line);'
    + ' background:var(--krs-face); color:var(--krs-ink); font-size:16px; font-weight:700; display:flex;'
    + ' align-items:center; justify-content:center; gap:8px;}'
    + '#kr-full .kr-danger{width:100%; min-height:54px; border-radius:15px; background:var(--krs-err-bg);'
    + ' border:1px solid var(--krs-err-line); color:var(--krs-err-ink); font-size:16px; font-weight:700;'
    + ' display:flex; align-items:center; justify-content:center;}'
    + '#kr-full .kr-spin{width:17px; height:17px; border-radius:50%; border:2.5px solid rgba(0,0,0,.22);'
    + ' border-top-color:var(--krs-btn-ink); animation:kr-sp .7s linear infinite;}'
    + '#kr-full .kr-empty{text-align:center; font-size:15px; color:var(--krs-mut); line-height:1.85;}'
    + '#kr-full .kr-empty .big{font-size:42px; display:block; margin-bottom:10px;}'
    + '#kr-full .kr-stack{display:flex; flex-direction:column; gap:10px; margin-top:18px;}'
    /* ── 電腦版：置中一欄、磚變小顆橫排，1 人／8 人都不會變荒原 ── */
    + '@media(min-width:900px){'
    +   '#kr-full .kr-h{font-size:32px; text-align:center;}'
    +   '#kr-full .kr-sub{font-size:15.5px; text-align:center; margin-bottom:26px;}'
    +   '#kr-full .kr-why{text-align:center;}'
    +   '#kr-full .kr-wrap{max-width:700px;}'
    +   '#kr-full .kr-wrap.narrow{max-width:400px;}'
    +   '#kr-full .kr-tile{flex:0 0 152px; min-height:150px;}'
    +   '#kr-full .kr-grid.many .kr-tile{flex:0 0 152px; min-height:150px;}'
    +   '#kr-full .kr-grid.many .kr-av{width:76px; height:76px; font-size:34px;}'
    +   '#kr-full .kr-av{width:76px; height:76px; font-size:34px;}'
    +   '#kr-full .kr-nm{font-size:15px;}'
    +   '#kr-full .kr-foot{padding-bottom:calc(10px + env(safe-area-inset-bottom));}'
    +   '#kr-full .kr-peek{max-width:520px; margin:0 auto;}'
    + '}'
    /* ── 矮螢幕密度（.kr-short / .kr-tiny / .kr-micro）──────────────────────────
     * ⚠️ **絕對不要改回 `@media(max-height:…)`**：媒體查詢吃的是 **CSS 視窗高度**，
     * 而 **iOS 鍵盤彈出時只縮 `visualViewport`、CSS 視窗高度一動也不動** ⇒ 媒體查詢永遠不觸發，
     * Android 會過、iPhone 不會（QA 退件實證：`--kr-vh` 設 407 時解鎖鈕可見高度 0px）。
     * 所以密度等級由 `applyDensity()` 依**實際量到的滿版高度**加／移除 class，
     * 跟 `--kr-vh`／`fitVH()` 走同一個高度來源；ResizeObserver 保證任何原因造成的高度變化都會重算。
     * 門檻是用**最壞情境**（理由條 ＋ 已打錯 2 次，錯誤條有兩行）定出來的，不是用單純情境。 */
    + '#kr-full.kr-short .kr-top{padding-top:calc(6px + env(safe-area-inset-top)); padding-bottom:2px;}'
    + '#kr-full.kr-short .kr-mid{padding-top:4px; padding-bottom:12px;}'
    + '#kr-full.kr-short .kr-h{font-size:21px; margin-bottom:4px;}'
    + '#kr-full.kr-short .kr-sub{font-size:13.5px; margin-bottom:12px;}'
    + '#kr-full.kr-short .kr-why{margin-bottom:10px; padding:9px 12px;}'
    + '#kr-full.kr-short .kr-tile{min-height:104px; gap:7px; padding:10px 8px;}'
    + '#kr-full.kr-short .kr-av{width:54px; height:54px; font-size:25px;}'
    + '#kr-full.kr-short .kr-grid.many .kr-tile{min-height:96px;}'
    + '#kr-full.kr-short .kr-grid.many .kr-av{width:44px; height:44px; font-size:21px;}'
    /* 身分區從直排改橫排：這是矮螢幕省高度最有效的一刀 */
    + '#kr-full.kr-short .kr-id{flex-direction:row; align-items:center; text-align:left; gap:12px; margin-bottom:14px;}'
    + '#kr-full.kr-short .kr-id .kr-av{width:48px; height:48px; font-size:23px;}'
    + '#kr-full.kr-short .kr-id b{font-size:18px;}'
    + '#kr-full.kr-short .kr-field{margin-bottom:10px;}'
    + '#kr-full.kr-short .kr-field input{min-height:50px;}'
    + '#kr-full.kr-short .kr-err{margin-bottom:10px; padding:9px 12px;}'
    + '#kr-full.kr-short .kr-check{min-height:46px;}'
    + '#kr-full.kr-short .kr-go, #kr-full.kr-short .kr-ghost, #kr-full.kr-short .kr-danger{min-height:50px;}'
    + '#kr-full.kr-short .kr-stack{margin-top:14px; gap:8px;}'
    + '#kr-full.kr-short .kr-peek{min-height:54px; padding:8px 14px;}'
    /* .kr-tiny（≤500）：副標讓路。順序要在 .kr-short 之後 —— 同權重靠後者勝出。 */
    + '#kr-full.kr-tiny .kr-x{min-width:44px; min-height:44px;}'
    + '#kr-full.kr-tiny .kr-mid{padding-top:2px; padding-bottom:8px;}'
    + '#kr-full.kr-tiny .kr-h{font-size:19px;}'
    + '#kr-full.kr-tiny .kr-sub{margin-bottom:10px;}'
    + '#kr-full.kr-tiny .kr-why{margin-bottom:8px; padding:8px 11px; font-size:13px;}'
    + '#kr-full.kr-tiny .kr-id{gap:10px; margin-bottom:10px;}'
    + '#kr-full.kr-tiny .kr-id .kr-av{width:32px; height:32px; font-size:17px;}'
    + '#kr-full.kr-tiny .kr-id b{font-size:16.5px;}'
    + '#kr-full.kr-tiny .kr-id div span{display:none;}'
    + '#kr-full.kr-tiny .kr-lb small{display:none;}'
    + '#kr-full.kr-tiny .kr-field{margin-bottom:8px;}'
    + '#kr-full.kr-tiny .kr-field input{min-height:48px;}'
    + '#kr-full.kr-tiny .kr-err{margin-bottom:8px; padding:8px 11px; font-size:13px;}'
    + '#kr-full.kr-tiny .kr-err span{font-size:11.5px; margin-top:2px;}'
    + '#kr-full.kr-tiny .kr-check{min-height:44px;}'
    + '#kr-full.kr-tiny .kr-go, #kr-full.kr-tiny .kr-ghost, #kr-full.kr-tiny .kr-danger{min-height:48px; margin-top:4px;}'
    + '#kr-full.kr-tiny .kr-tile{min-height:92px;}'
    + '#kr-full.kr-tiny .kr-av{width:44px; height:44px; font-size:21px;}'
    + '#kr-full.kr-tiny .kr-peek{min-height:50px; padding:5px 12px;}'
    + '#kr-full.kr-tiny .kr-peek b{font-size:14.5px;}'
    + '#kr-full.kr-tiny .kr-peek span{font-size:11.5px; margin-top:1px;}'
    /* .kr-micro（≤460）＝鍵盤佔掉大半個畫面。這一階刻意讓掉三樣**次要**的東西，
     * 換「密碼欄＋解鎖鈕＋出口」完整可見（它們是這一屏唯一的任務）：
     *   ① 理由條（上一屏已經看過同一句話）② 錯誤條的第二行說明 ③ 出口的第二行說明。
     * 觸控目標仍然全部 ≥44px、密碼欄仍然 16px —— 那兩條不准讓。 */
    + '#kr-full.kr-micro .kr-top{padding-top:calc(5px + env(safe-area-inset-top)); padding-bottom:1px;}'
    + '#kr-full.kr-micro .kr-mid{padding-top:2px; padding-bottom:6px;}'
    + '#kr-full.kr-micro .kr-h{font-size:18px; margin-bottom:2px;}'
    + '#kr-full.kr-micro .kr-sub{font-size:12.5px; margin-bottom:8px;}'
    + '#kr-full.kr-micro .kr-why{display:none;}'
    + '#kr-full.kr-micro .kr-id{gap:9px; margin-bottom:6px;}'
    + '#kr-full.kr-micro .kr-id .kr-av{width:26px; height:26px; font-size:14px;}'
    + '#kr-full.kr-micro .kr-id b{font-size:15.5px;}'
    + '#kr-full.kr-micro .kr-field{margin-bottom:6px;}'
    + '#kr-full.kr-micro .kr-field input{min-height:46px;}'
    + '#kr-full.kr-micro .kr-err{margin-bottom:6px; padding:6px 10px; font-size:12.5px;}'
    + '#kr-full.kr-micro .kr-err span{display:none;}'
    + '#kr-full.kr-micro .kr-check{min-height:44px;}'
    + '#kr-full.kr-micro .kr-go, #kr-full.kr-micro .kr-ghost, #kr-full.kr-micro .kr-danger{min-height:46px; margin-top:2px;}'
    + '#kr-full.kr-micro .kr-stack{margin-top:10px; gap:8px;}'
    + '#kr-full.kr-micro .kr-tile{min-height:78px; gap:5px; padding:8px 6px;}'
    + '#kr-full.kr-micro .kr-av{width:36px; height:36px; font-size:18px;}'
    + '#kr-full.kr-micro .kr-nm{font-size:13.5px;}'
    + '#kr-full.kr-micro .kr-peek{min-height:44px; padding:4px 12px;}'
    + '#kr-full.kr-micro .kr-peek b{font-size:14px;}'
    + '#kr-full.kr-micro .kr-peek span{display:none;}'
    /* ── 身分藥丸：住在 App 的畫面裡，所以只有它可以碰主色 ──
     * 提權用「同一個 class 寫兩次」(0,2,0)，不准綁宿主結構。
     * 底色永遠是模組固定的中性色，主色只准上前景（.kr-cta 的文字）。 */
    + '.kr-chip.kr-chip{display:inline-flex; align-items:center; gap:9px; min-height:44px; padding:0 15px;'
    + ' border-radius:99px; background:#f6f2ea; border:1px solid #e6dfd2; color:#5d554a;'
    + ' font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;'
    + ' font-size:13.5px; font-weight:700; line-height:1.3; letter-spacing:normal; text-align:left;'
    + ' text-decoration:none; cursor:pointer; margin:0; box-sizing:border-box;'
    + ' -webkit-appearance:none; appearance:none; box-shadow:none;'
    /* 同樣要擋繼承滲漏（它住在宿主的 footer 裡，宿主什麼都可能設） */
    + ' -webkit-tap-highlight-color:transparent; -webkit-text-size-adjust:100%; text-size-adjust:100%;'
    + ' font-style:normal; font-variant:normal; font-variant-numeric:normal; text-transform:none;'
    + ' text-indent:0; text-shadow:none; word-spacing:normal; white-space:nowrap;'
    + ' -webkit-font-smoothing:auto; -moz-osx-font-smoothing:auto;}'
    + '.kr-chip.kr-chip:hover{background:#f1ece2;}'
    + '.kr-chip.kr-chip .kr-dot{width:22px; height:22px; border-radius:50%; box-sizing:border-box; flex:0 0 auto;'
    + ' display:flex; align-items:center; justify-content:center; font-size:12px; line-height:1;'
    + ' box-shadow:inset 0 0 0 1px rgba(255,255,255,.35);}'
    + '.kr-chip.kr-chip .kr-cta{color:var(--acc,#c1553f); font-weight:800; box-sizing:border-box;}';

  /* 樣式要在 init() 就注入：footer 的身分藥丸每次進站都看得到，
   * 不能等到使用者第一次打開解鎖畫面（paint）才有樣式。 */
  function ensureStyle() {
    if (document.getElementById("kr-style")) return;
    var head = document.head || document.getElementsByTagName("head")[0];
    if (!head) { document.addEventListener("DOMContentLoaded", ensureStyle); return; }
    var st = document.createElement("style");
    st.id = "kr-style";
    st.textContent = CSS;
    head.appendChild(st);
  }

  /* 滿版蓋住整個畫面 -> 高度不能用 100vh（iOS 的 100vh 是「鍵盤沒彈出時」的高度）。
   * 用 visualViewport 維護 --kr-vh：鍵盤彈出時整層跟著縮，
   * .kr-foot 是 flex item（不是 fixed）所以自然停在鍵盤正上方。 */
  function fitVH() {
    var vv = global.visualViewport;
    var h = vv ? vv.height : global.innerHeight;
    if (h) document.documentElement.style.setProperty("--kr-vh", h + "px");
    applyDensity();
  }
  /* 密度等級：**用實際量到的滿版高度**決定，不是用 CSS 視窗高度。
   * ⚠️ 這裡不可以改用 @media(max-height:…)：iOS 鍵盤彈出只縮 visualViewport，
   *    CSS 視窗高度不變 -> 媒體查詢永遠不觸發（Android 會過、iPhone 不會）。
   * 量 layer 自己的高度（而不是只看 visualViewport），任何原因把它縮小都算數，
   * 包含測試用直接改 --kr-vh 的情況。 */
  var DENSITY = [["kr-short", 640], ["kr-tiny", 500], ["kr-micro", 460]];
  function applyDensity() {
    if (!layer) return;
    var h = layer.getBoundingClientRect().height;
    if (!h) {   /* 還沒顯示（display:none）時退回可視高度 */
      h = global.visualViewport ? global.visualViewport.height : global.innerHeight;
    }
    if (!h) return;
    for (var i = 0; i < DENSITY.length; i++) {
      if (h <= DENSITY[i][1]) layer.classList.add(DENSITY[i][0]);
      else layer.classList.remove(DENSITY[i][0]);
    }
  }

  function ensureDom() {
    if (layer) return layer;
    ensureStyle();
    layer = document.createElement("div");
    layer.id = "kr-full";
    layer.hidden = true;
    document.body.appendChild(layer);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !layer.hidden) close();
    });
    if (global.visualViewport) {
      global.visualViewport.addEventListener("resize", fitVH);
      global.visualViewport.addEventListener("scroll", fitVH);
    }
    global.addEventListener("resize", fitVH);
    /* 滿版高度只要變了就重算密度等級（鍵盤、轉向、或直接改 --kr-vh 都算）。
     * class 只影響子元素的尺寸、不影響 layer 自己的高度，所以不會回授成無限迴圈。 */
    if (global.ResizeObserver) {
      try { new global.ResizeObserver(applyDensity).observe(layer); } catch (e) { }
    }
    return layer;
  }
  /* 三段式：頂欄／中段（垂直置中、可捲）／底部常駐出口。foot 傳空字串就沒有那一條。 */
  function paint(top, body, foot, focusId) {
    ensureDom();
    if (layer.hidden) prevOverflow = document.body.style.overflow;
    layer.hidden = false;
    ui.open = true;
    layer.innerHTML = '<div class="kr-top">' + top + '</div>'
      + '<div class="kr-main"><div class="kr-mid">' + body + '</div></div>'
      + (foot ? '<div class="kr-foot">' + foot + '</div>' : '');
    document.body.style.overflow = "hidden";
    fitVH();
    if (focusId) setTimeout(function () { var el = document.getElementById(focusId); if (el) el.focus(); }, 70);
  }
  function close() {
    if (!layer) return;
    layer.hidden = true;
    layer.innerHTML = "";
    ui.open = false;
    document.body.style.overflow = (prevOverflow == null ? "" : prevOverflow);
    prevOverflow = null;
  }

  /* ---------------- 版面零件 ---------------- */
  /* App 的身分靠文字不靠顏色（零調色成本、零撞色風險） */
  function topBar(left) {
    return (left || '<div class="kr-app">' + esc(appLabel()) + '</div>')
      + '<button class="kr-x" onclick="Keyring.close()" aria-label="關閉">✕</button>';
  }
  /* 「先看看就好」＝底部常駐全寬出口。滿版不是鎖屏，隨時要走得掉：
   * ①這一條 ②右上 ✕ ③標題寫「誰要編輯？」而不是「誰在用？」。改文案等於改掉這個設計。 */
  function peekBar() {
    return '<button class="kr-peek" onclick="Keyring.peek()">'
      + '<b>👀 先看看就好</b><span>不用密碼也能看，只是不能改東西</span></button>';
  }

  /* ---------------- 解鎖畫面 ---------------- */
  function open(reason) {
    ui = { step: "who", userId: null, reason: reason || "", tries: 0, busy: false, show: false, remember: true, open: true };
    if (device) { openIdentity(); return; }
    draw();
    /* 每次開都對一次名單：後台剛加的人，這邊不用重整就看得到 */
    fetchRing(false).then(function () { if (ui.open) draw(); },
      function () { if (ui.open) draw(); });
  }
  /* 名單抓失敗／還沒有人時的重試 */
  function retry() {
    ringErr = ""; ring = null;
    draw();
    fetchRing(true).then(function () { if (ui.open) draw(); },
      function () { if (ui.open) draw(); });
  }
  function draw() {
    /* 只有一個人時跳過選人，直接進輸密碼（但仍顯示他的頭像確認是誰的鑰匙圈） */
    if (ui.step === "who" && ring && ringUsers().length === 1) {
      ui.step = "pw"; ui.userId = ringUsers()[0].id;
    }
    if (ui.step === "who") drawWho(); else drawPw();
  }
  function whyBar(short) {
    if (!ui.reason) return "";
    return '<div class="kr-why">要「' + esc(ui.reason) + '」得先解鎖'
      + (short ? '。' : '，選一下你是誰就好。') + '</div>';
  }
  function drawWho() {
    if (!ring) {
      /* 抓不到鑰匙圈：一定要講「你已經看得到內容，只是暫時不能編輯」——告訴他沒有壞掉 */
      var body = ringErr
        ? '<div class="kr-wrap narrow"><div class="kr-empty"><span class="big">🌧️</span>'
          + '現在拿不到鑰匙圈<br>可能是網路的關係。<br>你已經看得到內容，只是暫時不能編輯。'
          + '<div class="kr-stack"><button class="kr-ghost" onclick="Keyring.retry()">↻ 再抓一次</button></div>'
          + '</div></div>'
        : '<div class="kr-wrap narrow"><div class="kr-empty">正在拿鑰匙圈…</div></div>';
      paint(topBar(), body, peekBar());
      return;
    }
    var users = ringUsers();
    if (!users.length) {
      paint(topBar(),
        '<div class="kr-wrap narrow"><div class="kr-empty"><span class="big">🔑</span>'
        + '這個鑰匙圈裡還沒有人可以編輯。<br>跟 Benson 說一聲，他那邊配一組給你。'
        + '<div class="kr-stack"><button class="kr-ghost" onclick="Keyring.retry()">他說配好了？↻ 再抓一次</button></div>'
        + '</div></div>', peekBar());
      return;
    }
    var many = users.length > 6;
    var tiles = users.map(function (u) {
      var h = hintOf(u);
      return '<button class="kr-tile" onclick="Keyring.pick(\'' + esc(u.id) + '\')">'
        + '<span class="kr-av" style="background:' + grad(u.theme) + '">' + esc(u.emoji || "🧑") + '</span>'
        + '<span class="kr-tx"><span class="kr-nm">' + esc(u.name) + '</span>'
        + (h ? '<span class="kr-hint">' + esc(h) + '</span>' : '') + '</span></button>';
    }).join("");
    /* 標題是「誰要編輯？」不是「誰在用？」：後者暗示「你必須是其中一個」 */
    paint(topBar(),
      '<div class="kr-wrap">'
      + '<h2 class="kr-h">誰要編輯？</h2>'
      + '<p class="kr-sub">選自己、輸一次密碼，這台裝置就記住了。</p>'
      + whyBar(false)
      + '<div class="kr-grid' + (many ? ' many' : '') + '">' + tiles + '</div></div>',
      peekBar());
  }
  function drawPw() {
    var u = ringUser(ui.userId) || { name: "", emoji: "🧑", theme: "sunset" };
    var multi = ringUsers().length > 1;
    var h = hintOf(u);
    var err = "";
    if (ui.tries > 0) {
      err = '<div class="kr-err">密碼不對，再試一次'
        + (ui.tries >= 2 ? '<span>想不起來的話跟 Benson 說一聲，他那邊可以幫你換一組新的。</span>' : '')
        + '</div>';
    }
    var body = '<div class="kr-wrap narrow">'
      + whyBar(true)
      + '<div class="kr-id"><span class="kr-av" style="background:' + grad(u.theme) + '">' + esc(u.emoji || "🧑") + '</span>'
      + '<div><b>嗨，' + esc(u.name) + '</b><span>' + (h ? esc(h) + '・' : '') + '輸入密碼就可以編輯</span></div></div>'
      + '<form onsubmit="return Keyring.submit(event)">'
      + '<div class="kr-field">'
      + '<input id="kr-pw" type="' + (ui.show ? "text" : "password") + '" inputmode="text" '
      + 'autocomplete="current-password" autocapitalize="off" spellcheck="false" placeholder="你的密碼">'
      + '<button type="button" class="kr-eye" onclick="Keyring.toggleShow()" aria-label="顯示密碼">' + (ui.show ? "🙈" : "👁") + '</button>'
      + '</div>'
      + err
      + '<label class="kr-check"><input type="checkbox" id="kr-remember" ' + (ui.remember ? "checked" : "") + '>'
      + '<span class="kr-box"></span>'
      + '<span class="kr-lb">記住這台裝置<small>下次打開就直接能編輯。別人的電腦記得取消。</small></span></label>'
      + '<button class="kr-go" type="submit" ' + (ui.busy ? "disabled" : "") + '>'
      + (ui.busy ? '<span class="kr-spin"></span>解開中…' : '解鎖') + '</button>'
      + '</form></div>';
    var left = multi ? '<button class="kr-back" onclick="Keyring.backToWho()">‹ 換一個人</button>' : null;
    paint(topBar(left), body, peekBar(), "kr-pw");
  }

  function pick(id) { ui.step = "pw"; ui.userId = id; ui.tries = 0; draw(); }
  function backToWho() { ui.step = "who"; ui.userId = null; draw(); }
  function peek() { close(); say("好，就先看看。想編輯再點最下面那條"); }
  function toggleShow() {
    var inp = document.getElementById("kr-pw");
    var v = inp ? inp.value : "";
    var rem = document.getElementById("kr-remember");
    ui.remember = rem ? rem.checked : true;
    ui.show = !ui.show;
    draw();
    inp = document.getElementById("kr-pw");
    if (inp) { inp.value = v; inp.focus(); }
  }
  function submit(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (ui.busy) return false;
    var inp = document.getElementById("kr-pw");
    var pw = inp ? inp.value : "";
    var rem = document.getElementById("kr-remember");
    ui.remember = rem ? rem.checked : true;
    if (!pw) { say("先輸入密碼喔", true); return false; }
    var u = ringUser(ui.userId);
    var entry = u && u.apps ? u.apps[CFG.appId] : null;
    if (!entry) { say("這個人還沒有這個 App 的鑰匙", true); return false; }
    ui.busy = true; draw();
    var kdf = u.kdf || {};
    var theKey = null;
    deriveKey(pw, kdf.salt, kdf.iter)
      .then(function (key) { theKey = key; return decryptEntry(key, entry); })
      .then(function (token) { return exportKey(theKey).then(function (kb64) { return { token: token, k: kb64 }; }); })
      .then(function (r) {
        ui.busy = false;
        writeDevice({
          userId: u.id, name: u.name, emoji: u.emoji, theme: u.theme,
          at: new Date().toISOString(), k: r.k, t: r.token, remember: ui.remember
        });
        lsSet(K("introSeen"), "1");
        close();
        say("解開了，" + u.name + " 現在可以編輯 🎉");
        notify();
      })
      .catch(function () {
        /* 密碼錯的唯一症狀就是解不開——不做次數鎖定、不做倒數 */
        ui.busy = false; ui.tries++;
        draw();
        var el = document.getElementById("kr-pw");
        if (el) el.focus();
      });
    return false;
  }

  /* ---------------- 已解鎖：身分頁（v3 起也是滿版，跟解鎖同一套語言） ---------------- */
  function openIdentity() {
    if (!device) { open(""); return; }
    ui.open = true;
    /* 這一頁沒有 peek bar：已經解鎖了，「先看看」沒有意義，✕ 就是出口 */
    paint(topBar(),
      '<div class="kr-wrap narrow">'
      + '<div class="kr-id"><span class="kr-av" style="background:' + grad(device.theme) + '">' + esc(device.emoji || "🧑") + '</span>'
      + '<div><b>' + esc(device.name) + '</b><span>這台裝置記住了你的鑰匙，可以編輯</span></div></div>'
      + '<div class="kr-stack"><button class="kr-go" onclick="Keyring.close()">好，繼續用</button>'
      + '<button class="kr-ghost" onclick="Keyring.askSwitch()">🔄 換人用</button></div></div>', "");
  }
  function askSwitch() {
    ui.open = true;
    paint(topBar(),
      '<div class="kr-wrap narrow">'
      + '<h2 class="kr-h">要換人嗎？</h2>'
      + '<div class="kr-warn">換人會把這台裝置記住的鑰匙清掉，回到「只看看」。下一個人自己選名字、輸密碼就好。</div>'
      + '<div class="kr-stack"><button class="kr-danger" onclick="Keyring.doSwitch()">清掉，換人</button>'
      + '<button class="kr-ghost" onclick="Keyring.openIdentity()">先不要</button></div></div>', "");
  }
  function doSwitch() {
    forget();
    notify();
    say("已經清掉，換誰用都可以");
    open("");
  }

  /* ---------------- App 畫面裡的身分藥丸 ---------------- */
  function chipHtml() {
    if (!CFG.enabled) return "";
    ensureStyle();   /* 宿主可能還沒開過解鎖畫面，藥丸自己要保證有樣式 */
    if (device) {
      return '<button class="kr-chip" onclick="Keyring.openIdentity()">'
        + '<span class="kr-dot" style="background:' + grad(device.theme) + '"></span>'
        + esc(device.name) + '・可以編輯</button>';
    }
    /* 主色只上前景：.kr-cta 吃 var(--acc)，底色永遠是模組固定的中性色 */
    return '<button class="kr-chip" onclick="Keyring.open(\'\')">🔒 只看看模式・'
      + '<span class="kr-cta">點我解鎖 ›</span></button>';
  }

  /* 這台裝置從來沒解鎖過、也沒看過解鎖畫面 -> 進站約 0.9 秒主動端一次，之後永遠不再自動彈 */
  function maybeIntro() {
    if (!CFG.enabled || device || started) return;
    if (lsGet(K("introSeen")) === "1") return;
    started = true;
    fetchRing(false).then(function () {
      if (device || !ringUsers().length) return;
      setTimeout(function () {
        if (device || ui.open) return;
        lsSet(K("introSeen"), "1");
        open("");
      }, CFG.introDelay);
    }).catch(function () { /* 抓不到就別打擾 */ });
  }

  /* ---------------- init ---------------- */
  function init(opts) {
    Object.keys(opts || {}).forEach(function (k) { CFG[k] = opts[k]; });
    if (!CFG.ns) CFG.ns = "keyring." + (CFG.appId || "app") + ".";
    if (!CFG.enabled) return publicState();
    ensureStyle();   /* 進站就注入：身分藥丸在還沒開過解鎖畫面之前就要是對的樣子 */
    /* 本機救援用：想指到別份鑰匙圈（例如本機後台的預覽）就設 localStorage <ns>src */
    var override = lsGet(K("src"));
    if (override) CFG.url = override;
    device = readDevice();
    /* 同步把金鑰塞回 App 既有的 key，開機第一次判斷「能不能寫」就是對的 */
    if (device && device.t) writeToken(device.t, device.remember);
    /* 背景跟鑰匙圈對一次（換金鑰自動換過去；被刪／換密碼就靜默降級） */
    setTimeout(function () { refreshFromRing(); }, 0);
    return publicState();
  }

  var API = {
    init: init,
    open: open,
    close: close,
    peek: peek,
    retry: retry,
    pick: pick,
    backToWho: backToWho,
    toggleShow: toggleShow,
    submit: submit,
    openIdentity: openIdentity,
    askSwitch: askSwitch,
    doSwitch: doSwitch,
    chipHtml: chipHtml,
    maybeIntro: maybeIntro,
    forget: function () { forget(); notify(); },
    isUnlocked: function () { return !!device; },
    current: function () { return publicState(); },
    reload: function () { return fetchRing(true); },
    /* 給測試／進階用 */
    _cfg: CFG,
    _deriveKey: deriveKey,
    _decryptEntry: decryptEntry
  };

  global.Keyring = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : this);
