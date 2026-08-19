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
 * 樣式用 var(--acc, …) 這種寫法，套用 App 自己的色票；沒有就用內建的暖色系預設值。
 * 加解密參數與 keyring/server.js 是同一套，改要兩邊一起改。
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
    onChange: null,         /* function(state) 解鎖／換人／金鑰更新後呼叫 */
    toast: null,            /* function(msg, isErr) 借用 App 自己的 toast */
    /* 滿彩度漸層＝各 App 的「一趟旅程／一道菜」用的語言。
     * v2.1 起這個模組自己不再渲染它（身分是配角），留著當下面 tints 的來源對照：加新顏色時兩邊一起加。 */
    themes: {
      sunset: "linear-gradient(135deg,#ff8a80,#ff5f7e 55%,#c94b9d)",
      ocean:  "linear-gradient(135deg,#38c3a7,#2f8fd6)",
      night:  "linear-gradient(135deg,#6a7bf0,#8e54c9)",
      forest: "linear-gradient(135deg,#7ec96f,#3f9d8a)",
      sand:   "linear-gradient(135deg,#f5c65d,#f0855c)"
    },
    /* 頭像底色＝同一組漸層壓到 ~20%（v2.1 視覺改版）。
     * 身分是介面外框、不是內容：滿彩度大色塊是「一趟旅程」的語言，人只配得到一枚淡淡的標記。
     * 先算好放這裡，不要在 runtime 拆色碼算 alpha。 */
    tints: {
      sunset: "linear-gradient(135deg,rgba(255,138,128,.24),rgba(201,75,157,.20))",
      ocean:  "linear-gradient(135deg,rgba(56,195,167,.24),rgba(47,143,214,.20))",
      night:  "linear-gradient(135deg,rgba(106,123,240,.22),rgba(142,84,201,.20))",
      forest: "linear-gradient(135deg,rgba(126,201,111,.26),rgba(63,157,138,.22))",
      sand:   "linear-gradient(135deg,rgba(245,198,93,.30),rgba(240,133,92,.24))"
    }
  };

  var ring = null;          /* 抓回來的 keyring.json */
  var ringErr = "";
  var loading = null;       /* 抓取中的 promise */
  var device = null;        /* {userId,name,emoji,theme,at,k,t,remember} */
  var started = false;
  var layer = null;
  var ui = { step: "who", userId: null, reason: "", tries: 0, busy: false, show: false, remember: true, open: false };

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function tint(t) { return CFG.tints[t] || CFG.tints.sunset; }
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
   * ⚠️ 這份 CSS 是「注入到別人家的 App」裡跑的，宿主自己就有一整套 CSS。
   * 所以每一條規則都用「同一個 class 寫兩次」（`.kr-x.kr-x` ＝ 權重 0,2,0）提權，
   * 才壓得過宿主常見的 `.foo button` / `.foo input`（0,1,1）這種選擇器。
   * 血淚：v2.0 的珊瑚色「解鎖」鈕被自己的 `.kr-sheet button` 通則壓成透明，
   *      footer 身分藥丸被 travel-book 的 `.home-foot button` 壓成灰色小字。
   * 新增規則請照這個寫法，不要為了某個 App 寫死宿主結構（例如 `.home-foot .kr-chip`）——
   * 那樣下一個複製這個檔案的 App 又會壞一次。 */
  var CSS = ''
    + '#kr-layer{position:fixed; inset:0; z-index:120;}'
    + '#kr-layer[hidden]{display:none;}'
    + '.kr-backdrop.kr-backdrop{position:absolute; inset:0; background:rgba(30,22,14,.45); animation:kr-fade .2s;}'
    + '.kr-sheet.kr-sheet{position:absolute; bottom:0; left:0; right:0; margin:0 auto; max-width:480px; background:#fff;'
    + ' border-radius:22px 22px 0 0; padding:14px 18px calc(22px + env(safe-area-inset-bottom));'
    + ' max-height:90dvh; overflow-y:auto; animation:kr-up .26s cubic-bezier(.2,.8,.3,1);'
    + ' font-family:inherit; font-size:15px; line-height:1.5; text-align:left; color:var(--ink,#2b2620);}'
    + '@keyframes kr-up{from{transform:translateY(60%); opacity:.4;} to{transform:none; opacity:1;}}'
    + '@keyframes kr-fade{from{opacity:0;} to{opacity:1;}}'
    + '@keyframes kr-sp{to{transform:rotate(360deg);}}'
    + '.kr-sheet *{box-sizing:border-box;}'
    /* 內部通則：把宿主的 button 樣式洗掉。刻意維持 (0,1,1)，比下面每一條 (0,2,0) 都低。 */
    + '.kr-sheet button{font-family:inherit; border:none; background:none; cursor:pointer; color:inherit;'
    + ' padding:0; margin:0; appearance:none; -webkit-appearance:none; box-shadow:none; letter-spacing:normal;}'
    + '.kr-grab.kr-grab{width:38px; height:4px; border-radius:99px; background:#e4ddcf; margin:0 auto 10px;}'
    + '.kr-head.kr-head{display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; gap:8px;}'
    + '.kr-head.kr-head h3{font-size:19px; font-weight:800; margin:0; color:var(--ink,#2b2620); letter-spacing:normal;}'
    + '.kr-x.kr-x{min-width:46px; min-height:46px; font-size:18px; font-weight:400; color:var(--muted,#8f8578);'
    + ' display:flex; align-items:center; justify-content:center; flex:0 0 auto;}'
    + '.kr-why.kr-why{background:#fff1ef; color:var(--acc-deep,#e2503f); font-size:13.5px; font-weight:600;'
    + ' border-radius:13px; padding:11px 13px; margin:0 0 14px; line-height:1.5;}'
    + '.kr-sub.kr-sub{color:var(--muted,#8f8578); font-size:13.5px; margin:2px 0 12px; line-height:1.55;}'
    /* 選人：橫向暖卡列（v2.1） */
    + '.kr-grid.kr-grid{display:flex; flex-direction:column; gap:8px;}'
    + '.kr-tile.kr-tile{display:flex; flex-direction:row; align-items:center; gap:12px; min-height:64px; width:100%;'
    + ' padding:10px 12px; border-radius:16px; background:#fbf9f4; border:1px solid #efe9dd;'
    + ' color:var(--ink,#2b2620); font-size:15px; text-align:left;}'
    + '.kr-tile.kr-tile:active{background:#f5f1e8;}'
    + '.kr-tile.kr-tile .em{width:44px; height:44px; border-radius:14px; font-size:23px; line-height:1;'
    + ' display:flex; align-items:center; justify-content:center; flex:0 0 auto;}'
    + '.kr-tx.kr-tx{flex:1; min-width:0;}'
    + '.kr-tile.kr-tile .nm{display:block; font-size:16.5px; font-weight:700; color:var(--ink,#2b2620);}'
    + '.kr-tile.kr-tile .go{font-size:18px; line-height:1; color:#cfc5b3; flex:0 0 auto;}'
    + '.kr-peek.kr-peek{margin-top:10px; padding-top:6px; border-top:1px solid #f2ecdf; text-align:center;}'
    + '.kr-peek-link.kr-peek-link{min-height:44px; padding:0 14px; margin-top:2px; font-size:15px; font-weight:700;'
    + ' color:#6b6154; text-decoration:underline;}'
    + '.kr-back.kr-back{min-height:44px; padding:0 10px 0 0; font-size:14.5px; font-weight:700; color:var(--muted,#8f8578);}'
    + '.kr-field.kr-field{display:block; margin:0 0 13px; position:relative;}'
    + '.kr-field.kr-field input{width:100%; font-size:16px; font-family:inherit; font-weight:400; line-height:normal;'
    + ' color:var(--ink,#2b2620); padding:13px 56px 13px 13px; margin:0;'
    + ' border:1.5px solid var(--line,#e8e1d5); border-radius:13px; background:#fbfaf6;'
    + ' appearance:none; -webkit-appearance:none; box-shadow:none;}'
    + '.kr-field.kr-field input:focus{outline:none; border-color:var(--acc,#ff6b5e);}'
    + '.kr-eye.kr-eye{position:absolute; right:4px; top:50%; transform:translateY(-50%); width:48px; height:48px;'
    + ' display:flex; align-items:center; justify-content:center; font-size:18px; color:var(--muted,#8f8578);}'
    + '.kr-err.kr-err{background:#fbeeee; color:var(--bad,#d64545); font-size:13.5px; font-weight:700; border-radius:12px;'
    + ' padding:10px 12px; margin:10px 0 2px; line-height:1.5;}'
    + '.kr-err.kr-err span{display:block; font-weight:500; color:#a4655f; font-size:12.5px; margin-top:4px;}'
    + '.kr-check.kr-check{display:flex; align-items:center; gap:10px; min-height:48px; margin:0; cursor:pointer; position:relative;}'
    + '.kr-check.kr-check input{position:absolute; opacity:0; width:1px; height:1px; margin:0;}'
    + '.kr-box.kr-box{width:26px; height:26px; border-radius:8px; border:2px solid #d6cbb8; background:#fbfaf6; flex:0 0 auto;'
    + ' display:flex; align-items:center; justify-content:center; color:#fff; font-size:14px;}'
    + '.kr-check.kr-check input:checked + .kr-box{background:var(--acc,#ff6b5e); border-color:var(--acc,#ff6b5e);}'
    + '.kr-check.kr-check input:checked + .kr-box::after{content:"\\2713";}'
    + '.kr-lb.kr-lb{font-size:15.5px; font-weight:600; color:var(--ink,#2b2620);}'
    + '.kr-lb.kr-lb small{display:block; font-size:12.5px; color:var(--muted,#8f8578); font-weight:500; margin-top:2px;}'
    + '.kr-go.kr-go{width:100%; min-height:52px; border-radius:15px; background:var(--acc,#ff6b5e); color:#fff;'
    + ' font-size:17px; font-weight:800; display:flex; align-items:center; justify-content:center; gap:8px; margin-top:4px;}'
    + '.kr-go.kr-go[disabled]{opacity:.72;}'
    + '.kr-ghost.kr-ghost{width:100%; min-height:52px; border-radius:15px; border:1.5px solid var(--line,#e8e1d5);'
    + ' background:#fbfaf6; color:var(--ink,#2b2620); font-size:16px; font-weight:700;'
    + ' display:flex; align-items:center; justify-content:center; gap:6px;}'
    + '.kr-danger.kr-danger{width:100%; min-height:52px; border-radius:15px; background:#fbeeee; color:var(--bad,#d64545);'
    + ' font-size:16px; font-weight:700; display:flex; align-items:center; justify-content:center; gap:6px;}'
    + '.kr-spin.kr-spin{width:17px; height:17px; border-radius:50%; border:2.5px solid rgba(255,255,255,.45);'
    + ' border-top-color:#fff; animation:kr-sp .7s linear infinite;}'
    + '.kr-id.kr-id{display:flex; align-items:center; gap:12px; padding:2px 0 14px;}'
    + '.kr-id-face.kr-id-face{width:44px; height:44px; border-radius:14px; display:flex; align-items:center;'
    + ' justify-content:center; font-size:23px; flex:0 0 auto;}'
    + '.kr-id.kr-id b{display:block; font-size:18px; font-weight:700; color:var(--ink,#2b2620);}'
    + '.kr-id.kr-id span{display:block; font-size:13px; color:var(--muted,#8f8578); margin-top:2px;}'
    + '.kr-warn.kr-warn{background:#fff6e3; border:1px solid #f2dcae; border-radius:14px; padding:12px 14px;'
    + ' font-size:13.5px; color:#8a5b12; line-height:1.6; margin-bottom:12px;}'
    + '.kr-empty.kr-empty{text-align:center; color:var(--muted,#8f8578); font-size:14px; padding:18px 6px; line-height:1.7;}'
    /* 首頁 footer 的身分藥丸：跑在宿主的 footer 裡，宿主的 button 樣式全部要擋掉 */
    + '.kr-chip.kr-chip{display:inline-flex; align-items:center; gap:8px; min-height:44px; padding:0 16px;'
    + ' border-radius:99px; box-sizing:border-box; font-family:inherit; font-size:13.5px; font-weight:700;'
    + ' line-height:1.2; letter-spacing:normal; text-decoration:none; cursor:pointer;'
    + ' background:#fff1ef; color:var(--acc-deep,#e2503f); border:1px solid #ffd9d3;'
    + ' appearance:none; -webkit-appearance:none; box-shadow:none;}'
    + '.kr-chip.kr-chip.on{background:#f3eee4; color:#6b6154; border-color:var(--line,#e8e1d5);}'
    + '.kr-dot.kr-dot{width:24px; height:24px; border-radius:8px; box-sizing:border-box; display:flex;'
    + ' align-items:center; justify-content:center; font-size:14px; flex:0 0 auto;}';

  /* 樣式要在 init() 就注入：footer 的身分藥丸每次進站都看得到，
   * 不能等到使用者第一次打開 sheet（paint）才有樣式。 */
  function ensureStyle() {
    if (document.getElementById("kr-style")) return;
    var head = document.head || document.getElementsByTagName("head")[0];
    if (!head) { document.addEventListener("DOMContentLoaded", ensureStyle); return; }
    var st = document.createElement("style");
    st.id = "kr-style";
    st.textContent = CSS;
    head.appendChild(st);
  }

  function ensureDom() {
    if (layer) return layer;
    ensureStyle();
    layer = document.createElement("div");
    layer.id = "kr-layer";
    layer.hidden = true;
    document.body.appendChild(layer);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !layer.hidden) close();
    });
    return layer;
  }
  function paint(html, focusId) {
    ensureDom();
    layer.hidden = false;
    ui.open = true;
    layer.innerHTML = '<div class="kr-backdrop" onclick="Keyring.close()"></div><div class="kr-sheet">' + html + '</div>';
    if (focusId) setTimeout(function () { var el = document.getElementById(focusId); if (el) el.focus(); }, 60);
  }
  function close() {
    if (!layer) return;
    layer.hidden = true;
    layer.innerHTML = "";
    ui.open = false;
  }

  /* ---------------- 解鎖 sheet ---------------- */
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
    paint(ui.step === "who" ? sheetWho() : sheetPw(), ui.step === "pw" ? "kr-pw" : null);
  }
  function whyBar() {
    return ui.reason ? '<div class="kr-why">要「' + esc(ui.reason) + '」得先解鎖，選一下你是誰就好。</div>' : "";
  }
  /* 「不能改東西」併進連結文字（v2.1）：原本上面那行說明跟連結講的是同一件事 */
  function peekBlock() {
    return '<div class="kr-peek">'
      + '<button class="kr-peek-link" onclick="Keyring.peek()">先看看就好（不能改東西）</button></div>';
  }
  function sheetWho() {
    var body;
    if (!ring) {
      body = ringErr
        ? '<div class="kr-empty">🌧️ 現在拿不到鑰匙圈（可能是網路）。<br>'
          + '<button class="kr-peek-link" onclick="Keyring.retry()">再抓一次 ↻</button></div>'
        : '<div class="kr-empty">正在拿鑰匙圈…</div>';
    } else if (!ringUsers().length) {
      body = '<div class="kr-empty">這個鑰匙圈裡還沒有人可以編輯。<br>跟 Benson 說一聲，他那邊配一組給你。<br>'
        + '<button class="kr-peek-link" onclick="Keyring.retry()">他說配好了？再抓一次 ↻</button></div>';
    } else {
      body = '<p class="kr-sub">選自己、輸密碼，這台就記住了。</p><div class="kr-grid">'
        + ringUsers().map(function (u) {
          /* 漸層從整塊磚退到 44px 頭像底色（tint），一列一個人 */
          return '<button class="kr-tile" onclick="Keyring.pick(\'' + esc(u.id) + '\')">'
            + '<span class="em" style="background:' + tint(u.theme) + '">' + esc(u.emoji || "🧑") + '</span>'
            + '<span class="kr-tx"><span class="nm">' + esc(u.name) + '</span></span>'
            + '<span class="go">›</span></button>';
        }).join("")
        + '</div>';
    }
    return '<div class="kr-grab"></div>'
      + '<div class="kr-head"><h3>誰在用？</h3><button class="kr-x" onclick="Keyring.close()" aria-label="關閉">✕</button></div>'
      + whyBar() + body + peekBlock();
  }
  function sheetPw() {
    var u = ringUser(ui.userId) || { name: "", emoji: "🧑", theme: "sunset" };
    var multi = ringUsers().length > 1;
    var err = "";
    if (ui.tries > 0) {
      err = '<div class="kr-err">密碼不對，再試一次'
        + (ui.tries >= 2 ? '<span>想不起來的話跟 Benson 說一聲，他那邊可以幫你換一組新的。</span>' : '')
        + '</div>';
    }
    return '<div class="kr-grab"></div>'
      + '<div class="kr-head">'
      + (multi ? '<button class="kr-back" onclick="Keyring.backToWho()">‹ 換一個人</button>' : '<span></span>')
      + '<button class="kr-x" onclick="Keyring.close()" aria-label="關閉">✕</button></div>'
      + (ui.reason ? '<div class="kr-why">要「' + esc(ui.reason) + '」得先解鎖。</div>' : "")
      + '<div class="kr-id"><div class="kr-id-face" style="background:' + tint(u.theme) + '">' + esc(u.emoji || "🧑") + '</div>'
      + '<div><b>' + esc(u.name) + '</b><span>輸入密碼就可以編輯</span></div></div>'
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
      + '</form>'
      + peekBlock();
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

  /* ---------------- 已解鎖：身分 sheet ---------------- */
  function openIdentity() {
    if (!device) { open(""); return; }
    paint('<div class="kr-grab"></div>'
      + '<div class="kr-head"><h3>現在是你在用</h3><button class="kr-x" onclick="Keyring.close()" aria-label="關閉">✕</button></div>'
      + '<div class="kr-id"><div class="kr-id-face" style="background:' + tint(device.theme) + '">' + esc(device.emoji || "🧑") + '</div>'
      + '<div><b>' + esc(device.name) + '</b><span>這台裝置記住了你的鑰匙，可以編輯</span></div></div>'
      + '<button class="kr-ghost" onclick="Keyring.askSwitch()" style="margin-bottom:10px">🔄 換人用</button>'
      + '<button class="kr-go" onclick="Keyring.close()">好，繼續用</button>');
  }
  function askSwitch() {
    paint('<div class="kr-grab"></div>'
      + '<div class="kr-head"><h3>要換人嗎？</h3><button class="kr-x" onclick="Keyring.close()" aria-label="關閉">✕</button></div>'
      + '<div class="kr-warn">換人會把這台裝置記住的鑰匙清掉，回到「只看看」。<br>下一個人自己選名字、輸密碼就好。</div>'
      + '<button class="kr-danger" onclick="Keyring.doSwitch()" style="margin-bottom:10px">清掉，換人</button>'
      + '<button class="kr-ghost" onclick="Keyring.openIdentity()">先不要</button>');
  }
  function doSwitch() {
    forget();
    notify();
    say("已經清掉，換誰用都可以");
    open("");
  }

  /* ---------------- 首頁 footer 的身分藥丸 ---------------- */
  function chipHtml() {
    if (!CFG.enabled) return "";
    ensureStyle();   /* 宿主可能還沒開過 sheet，藥丸自己要保證有樣式 */
    if (device) {
      /* 頭像一律用 tint（跟 sheet 裡的 44px 頭像同一種語言），不要用滿彩度的 grad */
      return '<button class="kr-chip on" onclick="Keyring.openIdentity()">'
        + '<span class="kr-dot" style="background:' + tint(device.theme) + '">' + esc(device.emoji || "🧑") + '</span>'
        + esc(device.name) + '・可以編輯</button>';
    }
    return '<button class="kr-chip" onclick="Keyring.open(\'\')">🔒 只看看模式・點我解鎖</button>';
  }

  /* 這台裝置從來沒解鎖過、也沒看過這個 sheet -> 進站約 0.9 秒主動端一次，之後永遠不再自動彈 */
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
    ensureStyle();   /* 進站就注入：footer 身分藥丸在還沒開過 sheet 之前就要是對的樣子 */
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
