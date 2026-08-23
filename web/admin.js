"use strict";
/*
 * 鑰匙圈手機後台 — 純靜態，沒有任何伺服器（放 GitHub Pages 就能用）
 *
 * 它怎麼有辦法改東西：
 *   本機後台會把 secrets.json 整份加密成公開的 vault.json（明文 PAT ＋ 每個人的派生金鑰）。
 *   這一頁抓 vault.json，用「管理密碼 ＋ 裝置配對碼」在**瀏覽器裡**解開，改完重新加密，
 *   再用 vault 裡存的 GitHub 金鑰，透過 GitHub API 把 vault.json 與 keyring.json 一起寫回去。
 *   解開的東西一秒都沒離開這台裝置，也沒有任何後端看得到它。
 *
 * 為什麼要配對碼：vault.json 是公開檔案。只靠密碼的話，「猜到密碼 ＝ 拿到所有 App 的 PAT」。
 *   配對碼是本機後台產的隨機碼，只住在裝置裡（這裡是 localStorage），不進任何公開檔案，
 *   所以整份 vault.json 被抓走也解不開。第一次要貼一次，之後這台裝置只要輸密碼。
 *
 * 加解密參數與 server.js／keyring-unlock.js 是同一套（PBKDF2-SHA256 600000 ＋ AES-GCM 256），
 * 改要三邊一起改。
 */

var CFG = { owner: "xd1104", repo: "keyring", branch: "main", vaultUrl: "../vault.json" };
var NS = "keyring.admin.";
var ITER = 600000;

/* 跟桌面後台同一套（public/admin.js），兩邊看起來才是同一個工具 */
var THEMES = {
  sunset: "linear-gradient(135deg,#ff8a80,#ff5f7e 55%,#c94b9d)",
  ocean:  "linear-gradient(135deg,#38c3a7,#2f8fd6)",
  night:  "linear-gradient(135deg,#6a7bf0,#8e54c9)",
  forest: "linear-gradient(135deg,#7ec96f,#3f9d8a)",
  sand:   "linear-gradient(135deg,#f5c65d,#f0855c)"
};
var THEME_KEYS = Object.keys(THEMES);
var EMOJIS = ["🧔","👩","🧑","👧","👦","🐱","🐶","🦊","🐻","🌻","⭐","🍀"];
var APP_EMOJIS = ["📦","🧳","🍳","🏋️","📓","🎮"];

var ST = {
  pairing: "",
  keyBytes: null,     /* 解 vault 的金鑰，只在記憶體裡 */
  vaultSalt: "",
  vaultIter: ITER,
  P: null,            /* 解開的真本 */
  baseSha: "",        /* 載入當下 GitHub 上的 commit，存檔時用來擋「別的裝置剛改過」 */
  tab: "users",
  busy: false,
  status: { kind: "ok", title: "已經是最新的", detail: "" }
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function grad(t) { return THEMES[t] || THEMES.sunset; }
var toastTimer = null;
function toast(msg, bad) {
  var el = $("toast");
  el.textContent = msg;
  el.className = bad ? "bad" : "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = (bad ? "bad " : "") + "hidden"; }, 3600);
}
function nowIso() { return new Date().toISOString(); }
function fmtTime(iso) {
  var d = new Date(iso || "");
  if (isNaN(d.getTime())) return "";
  return (d.getMonth() + 1) + "/" + d.getDate() + " " +
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
/* id 鐵律（跟 server.js 一樣）：一律 ASCII，顯示用的原文留在 name */
function slugify(s) {
  var t = String(s || "").normalize("NFC").trim().toLowerCase().replace(/\s+/g, "-");
  var out = "";
  for (var i = 0; i < t.length; i++) if (/[a-z0-9._-]/.test(t[i])) out += t[i];
  return out.replace(/^[-.]+|[-.]+$/g, "");
}
function newId(prefix) {
  return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
}
function uniqueId(base, taken) {
  var id = base, n = 2;
  while (taken.indexOf(id) >= 0) id = base + "-" + (n++);
  return id;
}
function maskToken(t) {
  var s = String(t || "");
  if (!s) return "";
  if (s.length <= 18) return s.slice(0, 3) + "••••••••";
  return s.slice(0, 14) + "••••••••" + s.slice(-4);
}
function userById(id) { return (ST.P.users || []).filter(function (u) { return u.id === id; })[0] || null; }
function appById(id) { return (ST.P.apps || []).filter(function (a) { return a.id === id; })[0] || null; }

/* ------------------------------------------------------------------ */
/* base64 / 加解密（WebCrypto）                                         */
/* ------------------------------------------------------------------ */
function b64ToBytes(b64) {
  var bin = atob(String(b64 || "").replace(/\s+/g, ""));
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  var b = new Uint8Array(bytes), s = "";
  for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function textToB64(text) { return bytesToB64(new TextEncoder().encode(text)); }
function b64ToText(b64) { return new TextDecoder().decode(b64ToBytes(b64)); }

function subtle() {
  if (!window.crypto || !crypto.subtle) {
    throw new Error("這個瀏覽器不能解密（要用 https 開這一頁，http 或檔案直接打開都不行）");
  }
  return crypto.subtle;
}
function pbkdf2(material, saltB64, iter) {
  return subtle().importKey("raw", new TextEncoder().encode(material), { name: "PBKDF2" }, false, ["deriveBits"])
    .then(function (k) {
      return subtle().deriveBits(
        { name: "PBKDF2", salt: b64ToBytes(saltB64), iterations: iter || ITER, hash: "SHA-256" }, k, 256);
    })
    .then(function (bits) { return new Uint8Array(bits); });
}
function aesKey(bytes, usages) {
  return subtle().importKey("raw", bytes, { name: "AES-GCM", length: 256 }, false, usages);
}
/* WebCrypto 的密文尾巴自帶 16 bytes authTag —— server.js 那邊會自己接回去，格式一致 */
function encWith(keyBytes, text) {
  var iv = crypto.getRandomValues(new Uint8Array(12));
  return aesKey(keyBytes, ["encrypt"]).then(function (k) {
    return subtle().encrypt({ name: "AES-GCM", iv: iv }, k, new TextEncoder().encode(text));
  }).then(function (ct) {
    return { iv: bytesToB64(iv), cipher: bytesToB64(ct) };
  });
}
function decWith(keyBytes, ivB64, cipherB64) {
  return aesKey(keyBytes, ["decrypt"]).then(function (k) {
    return subtle().decrypt({ name: "AES-GCM", iv: b64ToBytes(ivB64) }, k, b64ToBytes(cipherB64));
  }).then(function (buf) { return new TextDecoder().decode(buf); });
}
function randomB64(n) { return bytesToB64(crypto.getRandomValues(new Uint8Array(n))); }

/* 配對碼：使用者會打小寫、漏連字號、把 O 打成 0 —— 正規化規則要跟 server.js 一模一樣 */
function normalizePairing(s) {
  return String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0").replace(/[IL]/g, "1");
}

/* ------------------------------------------------------------------ */
/* vault：抓下來、解開、包回去                                          */
/* ------------------------------------------------------------------ */
function fetchVaultPublic() {
  return fetch(CFG.vaultUrl + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) {
    if (r.status === 404) throw new Error("這個鑰匙圈還沒開手機後台：先在電腦上打開本機後台，設一組管理密碼。");
    if (!r.ok) throw new Error("抓不到 vault.json（HTTP " + r.status + "）");
    return r.json();
  }, function () { throw new Error("連不到網路，抓不到 vault.json"); });
}
/* 有金鑰就走 API：GitHub Pages 有 CDN 快取，別的裝置剛存的東西可能要好幾分鐘才看得到，
 * 而「拿到舊的真本再存回去」＝ 把對方的改動蓋掉。所以只要能走 API 就一定走 API。 */
function fetchVaultApi(token) {
  return gh("/contents/vault.json?ref=" + CFG.branch, "GET", null, token).then(function (d) {
    return JSON.parse(b64ToText(d.content || ""));
  });
}
function openVault(doc, keyBytes) {
  return decWith(keyBytes, doc.iv, doc.cipher).then(function (text) {
    var p = JSON.parse(text);
    p.apps = Array.isArray(p.apps) ? p.apps : [];
    p.users = Array.isArray(p.users) ? p.users : [];
    p.users.forEach(function (u) { if (!Array.isArray(u.apps)) u.apps = []; });
    p.github = p.github || {};
    return p;
  }, function () {
    throw new Error("解不開：密碼或配對碼不對。（兩個都要對，錯哪一個看起來都一樣）");
  });
}
function ghToken() { return (ST.P && ST.P.github && ST.P.github.token) || ""; }

/* 公開的 keyring.json —— 跟 server.js 的 buildKeyring 必須產出同一種東西 */
function buildKeyring(p, stamp) {
  var apps = p.apps.map(function (a) { return { id: a.id, name: a.name, emoji: a.emoji }; });
  return Promise.all(p.users.map(function (u) {
    var entries = (u.apps || []).map(function (appId) {
      var app = appById(appId);
      if (!app || !app.token || !u.dk) return null;
      return encWith(b64ToBytes(u.dk), app.token).then(function (e) {
        return { appId: appId, iv: e.iv, cipher: e.cipher };
      });
    }).filter(Boolean);
    return Promise.all(entries).then(function (list) {
      var m = {};
      list.forEach(function (x) { m[x.appId] = { iv: x.iv, cipher: x.cipher }; });
      return {
        id: u.id, name: u.name, emoji: u.emoji, theme: u.theme,
        kdf: { algo: "PBKDF2-SHA256", iter: ITER, salt: u.salt },
        apps: m
      };
    });
  })).then(function (users) {
    return { version: 1, updatedAt: stamp, apps: apps, users: users };
  });
}

/* ------------------------------------------------------------------ */
/* GitHub API                                                          */
/* ------------------------------------------------------------------ */
function gh(path, method, body, token) {
  var tk = token || ghToken();
  if (!tk) return Promise.reject(new Error("還沒有 GitHub 金鑰，沒辦法寫回去"));
  return fetch("https://api.github.com/repos/" + CFG.owner + "/" + CFG.repo + path, {
    method: method || "GET",
    headers: {
      "Authorization": "Bearer " + tk,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (r.ok) return d;
      throw new Error(ghMsg(r.status, d));
    });
  }, function () { throw new Error("連不到 GitHub（網路問題），這次沒有存出去"); });
}
function ghMsg(status, d) {
  if (status === 401) return "GitHub 說這把金鑰無效（過期或被撤銷了）。到設定換一把新的。";
  if (status === 403) return "GitHub 不讓這把金鑰寫入。它需要 " + CFG.owner + "/" + CFG.repo + " 的 Contents: Read and write。";
  if (status === 404) return "GitHub 上找不到 " + CFG.owner + "/" + CFG.repo + "（或這把金鑰看不到它）。";
  if (status === 409 || status === 422) return "GitHub 上有別的裝置剛改過，這次沒有存出去。";
  return "GitHub 回了錯誤（" + status + "）：" + String((d && d.message) || "").slice(0, 120);
}
function headSha() {
  return gh("/git/ref/heads/" + CFG.branch).then(function (d) { return d.object.sha; });
}
/* 兩個檔案包成同一個 commit：不能讓 keyring.json 更新了、vault.json 還是舊的 */
function pushFiles(files, message) {
  var baseSha, treeSha;
  return headSha().then(function (sha) {
    baseSha = sha;
    return gh("/git/commits/" + sha);
  }).then(function (c) {
    treeSha = c.tree.sha;
    return Promise.all(files.map(function (f) {
      return gh("/git/blobs", "POST", { content: textToB64(f.text), encoding: "base64" });
    }));
  }).then(function (blobs) {
    return gh("/git/trees", "POST", {
      base_tree: treeSha,
      tree: files.map(function (f, i) {
        return { path: f.path, mode: "100644", type: "blob", sha: blobs[i].sha };
      })
    });
  }).then(function (tree) {
    return gh("/git/commits", "POST", { message: message, tree: tree.sha, parents: [baseSha] });
  }).then(function (commit) {
    /* force:false —— 這中間如果有人 push，寧可整筆失敗也不要蓋掉他 */
    return gh("/git/refs/heads/" + CFG.branch, "PATCH", { sha: commit.sha, force: false })
      .then(function () { return commit.sha; });
  });
}

/* ------------------------------------------------------------------ */
/* 存檔（跟本機後台一樣：改了就直接發布，沒有草稿狀態）                    */
/* ------------------------------------------------------------------ */
function save(what) {
  if (ST.busy) return Promise.reject(new Error("上一筆還在存，等一下下"));
  if (!ghToken()) { askGithubToken(); return Promise.reject(new Error("先給一把 GitHub 金鑰")); }
  ST.busy = true;
  ST.status = { kind: "busy", title: "存到 GitHub…", detail: what || "" };
  render();

  var stamp = nowIso();
  /* 存之前先確認 GitHub 上沒有別的裝置剛改過。改過就整份重新載入，
   * 寧可叫使用者再做一次，也不要拿舊的真本蓋掉電腦那邊剛存的東西。 */
  return headSha().then(function (sha) {
    if (ST.baseSha && sha !== ST.baseSha) {
      return reloadFromGithub().then(function () {
        throw new Error("有別的裝置剛改過，已經幫你載入最新的了 —— 剛剛那一筆請再做一次");
      });
    }
    ST.P.updatedAt = stamp;
    return buildKeyring(ST.P, stamp);
  }).then(function (keyring) {
    return encWith(ST.keyBytes, JSON.stringify(ST.P)).then(function (e) {
      var vault = {
        version: 1, updatedAt: stamp,
        kdf: { algo: "PBKDF2-SHA256", iter: ST.vaultIter, salt: ST.vaultSalt },
        iv: e.iv, cipher: e.cipher
      };
      return pushFiles([
        { path: "keyring.json", text: JSON.stringify(keyring, null, 2) + "\n" },
        { path: "vault.json", text: JSON.stringify(vault, null, 2) + "\n" }
      ], "keyring: 手機後台更新 " + stamp);
    });
  }).then(function (sha) {
    ST.baseSha = sha;
    ST.busy = false;
    ST.status = { kind: "ok", title: "已經存到 GitHub", detail: (what ? what + " · " : "") + fmtTime(stamp) };
    render();
    toast("存好了");
  }, function (e) {
    ST.busy = false;
    ST.status = { kind: "bad", title: "這一筆沒有存出去", detail: String(e && e.message || e) };
    render();
    throw e;
  });
}

function reloadFromGithub() {
  var tk = ghToken();
  return (tk ? fetchVaultApi(tk) : fetchVaultPublic()).then(function (doc) {
    ST.vaultSalt = (doc.kdf && doc.kdf.salt) || ST.vaultSalt;
    ST.vaultIter = (doc.kdf && doc.kdf.iter) || ST.vaultIter;
    return openVault(doc, ST.keyBytes);
  }).then(function (p) {
    ST.P = p;
    return headSha().catch(function () { return ""; });
  }).then(function (sha) {
    if (sha) ST.baseSha = sha;
    render();
  });
}

/* ------------------------------------------------------------------ */
/* 解鎖畫面                                                            */
/* ------------------------------------------------------------------ */
var lockErr = "";

function renderLock() {
  $("app").hidden = true;
  $("lock").hidden = false;
  var known = !!ST.pairing;
  $("lock").innerHTML =
    '<div class="lk-head"><div class="big">🔑</div>' +
      '<h1>鑰匙圈後台</h1>' +
      '<p>' + (known
        ? "這台裝置已經配對過了，輸密碼就好"
        : "第一次在這台裝置開，要先貼一次配對碼<br>（在電腦的本機後台上「手機後台」那一塊）") + '</p></div>' +
    (lockErr ? '<div class="lk-err">' + esc(lockErr) + '</div>' : "") +
    '<div class="lk-card">' +
      (known ? "" :
        '<label class="field"><span class="fl">裝置配對碼</span>' +
        '<input id="lk-pair" type="text" inputmode="latin" autocapitalize="characters" ' +
        'autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX"></label>') +
      '<label class="field"><span class="fl">管理密碼</span>' +
      '<input id="lk-pw" type="password" autocomplete="current-password" placeholder="在電腦上設的那一組"></label>' +
      '<p class="why">兩個都對才解得開。解開的東西只留在這台裝置上，' +
      '沒有任何伺服器看得到它。</p>' +
      '<button class="lk-btn" id="lk-go">解鎖</button>' +
      (known ? '<button class="lk-alt" id="lk-forget">換一組配對碼</button>' : "") +
    '</div>' +
    '<p class="lk-foot">改東西之前會先跟 GitHub 對一次，<br>不會蓋掉電腦那邊剛存的改動。</p>';

  $("lk-go").onclick = doUnlock;
  var pw = $("lk-pw");
  pw.onkeydown = function (e) { if (e.key === "Enter") doUnlock(); };
  if ($("lk-forget")) $("lk-forget").onclick = function () {
    ST.pairing = "";
    try { localStorage.removeItem(NS + "pairing"); } catch (e) {}
    lockErr = "";
    renderLock();
  };
  setTimeout(function () { (known ? pw : $("lk-pair")).focus(); }, 60);
}

function doUnlock() {
  var btn = $("lk-go");
  var pair = $("lk-pair") ? $("lk-pair").value : ST.pairing;
  var pw = $("lk-pw").value;
  if (!normalizePairing(pair)) { lockErr = "先貼上配對碼"; return renderLock(); }
  if (!pw) { lockErr = "還沒輸密碼"; return renderLock(); }
  btn.disabled = true;
  btn.textContent = "解開中…";
  lockErr = "";

  var doc = null;
  fetchVaultPublic().then(function (d) {
    doc = d;
    ST.vaultSalt = (d.kdf && d.kdf.salt) || "";
    ST.vaultIter = (d.kdf && d.kdf.iter) || ITER;
    if (!ST.vaultSalt) throw new Error("vault.json 裡沒有 salt，格式不對");
    return pbkdf2(String(pw) + "\n" + normalizePairing(pair), ST.vaultSalt, ST.vaultIter);
  }).then(function (keyBytes) {
    ST.keyBytes = keyBytes;
    return openVault(doc, keyBytes);
  }).then(function (p) {
    ST.P = p;
    ST.pairing = normalizePairing(pair);
    try { localStorage.setItem(NS + "pairing", ST.pairing); } catch (e) {}
    $("lock").hidden = true;
    $("app").hidden = false;
    ST.status = { kind: "ok", title: "已經是最新的", detail: fmtTime(p.updatedAt) };
    render();
    /* Pages 有 CDN 快取，剛剛那份可能是幾分鐘前的 —— 有金鑰就立刻換成 API 上的最新版 */
    if (ghToken()) reloadFromGithub().catch(function (e) { toast(String(e.message || e), true); });
  }).catch(function (e) {
    ST.keyBytes = null;
    lockErr = String((e && e.message) || e);
    renderLock();
  });
}

function lock() {
  ST.keyBytes = null; ST.P = null; ST.baseSha = "";
  $("app").hidden = true;
  renderLock();
}

/* ------------------------------------------------------------------ */
/* 主畫面                                                              */
/* ------------------------------------------------------------------ */
function render() {
  if (!ST.P) return;
  var el = $("app");
  el.innerHTML =
    '<div class="ad-head"><h1>🔑 鑰匙圈</h1>' +
      '<button id="bt-reload" title="重新載入">↻</button>' +
      '<button id="bt-set" title="設定">⚙︎</button></div>' +
    statusBarHtml() +
    '<div class="ad-tabs">' +
      '<button data-tab="users" class="' + (ST.tab === "users" ? "on" : "") + '">成員</button>' +
      '<button data-tab="apps" class="' + (ST.tab === "apps" ? "on" : "") + '">App</button>' +
    '</div>' +
    (ST.tab === "users" ? usersHtml() : appsHtml()) +
    '<p class="ad-foot">改了就直接存到 GitHub，沒有草稿狀態。<br>' +
      '最後更新 ' + esc(fmtTime(ST.P.updatedAt) || "—") + '</p>';

  $("bt-reload").onclick = function () {
    toast("重新載入中…");
    reloadFromGithub().then(function () { toast("已經是最新的"); },
      function (e) { toast(String(e.message || e), true); });
  };
  $("bt-set").onclick = settingsSheet;
  Array.prototype.forEach.call(el.querySelectorAll(".ad-tabs button"), function (b) {
    b.onclick = function () { ST.tab = b.getAttribute("data-tab"); render(); };
  });
  Array.prototype.forEach.call(el.querySelectorAll("[data-user]"), function (b) {
    b.onclick = function () { userMenu(userById(b.getAttribute("data-user"))); };
  });
  Array.prototype.forEach.call(el.querySelectorAll("[data-app]"), function (b) {
    b.onclick = function () { appMenu(appById(b.getAttribute("data-app"))); };
  });
  if ($("add-user")) $("add-user").onclick = function () { userSheet(null); };
  if ($("add-app")) $("add-app").onclick = function () { appSheet(null); };
  if ($("bt-retry")) $("bt-retry").onclick = function () {
    reloadFromGithub().then(function () { toast("已經是最新的"); },
      function (e) { toast(String(e.message || e), true); });
  };
}

function statusBarHtml() {
  var s = ST.status;
  var cls = s.kind === "bad" ? "bad" : (s.kind === "busy" ? "busy" : "");
  return '<div class="pub-bar ' + cls + '">' +
    '<div class="pub-txt"><b>' + esc(s.title) + '</b>' +
      (s.detail ? '<span>' + esc(s.detail) + '</span>' : "") + '</div>' +
    (s.kind === "bad" ? '<button id="bt-retry">重新載入</button>' : "") +
    '</div>';
}

function usersHtml() {
  if (!ST.P.users.length) {
    return '<div class="empty"><div class="big">🧑</div>' +
      '<p>還沒有任何成員。<br>加一個人，給他一組密碼，他就能在手機上解鎖那些 App。</p></div>' +
      '<button class="addcard" id="add-user">＋ 加一個人</button>';
  }
  return ST.P.users.map(function (u) {
    var chips = (u.apps || []).map(function (id) {
      var a = appById(id);
      return a ? '<span class="chip">' + esc(a.emoji + " " + a.name) + '</span>' : "";
    }).join("");
    return '<div class="rowcard">' +
      '<div class="rc-face" style="background:' + grad(u.theme) + '">' + esc(u.emoji || "🧑") + '</div>' +
      '<div class="rc-bd"><b>' + esc(u.name) + '</b>' +
        '<div class="chips">' + (chips || '<span class="chip none">一個 App 都沒給</span>') + '</div></div>' +
      '<button class="rc-more" data-user="' + esc(u.id) + '">⋯</button>' +
    '</div>';
  }).join("") + '<button class="addcard" id="add-user">＋ 加一個人</button>';
}

function appsHtml() {
  if (!ST.P.apps.length) {
    return '<div class="empty"><div class="big">📦</div>' +
      '<p>還沒有登記任何 App。<br>登記的代號要跟那個 App 前端的 appId 一模一樣。</p></div>' +
      '<button class="addcard" id="add-app">＋ 登記一個 App</button>';
  }
  return ST.P.apps.map(function (a) {
    var who = ST.P.users.filter(function (u) { return (u.apps || []).indexOf(a.id) >= 0; });
    var chips = who.map(function (u) { return '<span class="chip">' + esc(u.emoji + " " + u.name) + '</span>'; }).join("");
    return '<div class="rowcard">' +
      '<div class="rc-face" style="background:#efe8db; color:#6b6154">' + esc(a.emoji || "📦") + '</div>' +
      '<div class="rc-bd"><b>' + esc(a.name) + '</b>' +
        '<div class="chips">' + (chips || '<span class="chip none">還沒給任何人</span>') + '</div>' +
        '<div class="keyline">' + esc(a.id) + ' · ' + esc(a.token ? maskToken(a.token) : "沒有金鑰") + '</div>' +
      '</div>' +
      '<button class="rc-more" data-app="' + esc(a.id) + '">⋯</button>' +
    '</div>';
  }).join("") + '<button class="addcard" id="add-app">＋ 登記一個 App</button>';
}

/* ------------------------------------------------------------------ */
/* sheet                                                               */
/* ------------------------------------------------------------------ */
function openSheet(title, bodyHtml, wire) {
  var layer = $("sheet-layer");
  layer.hidden = false;
  layer.innerHTML =
    '<div class="backdrop"></div>' +
    '<div class="sheet"><div class="sheet-head"><h3>' + esc(title) + '</h3>' +
      '<button id="sh-x">✕</button></div>' + bodyHtml + '</div>';
  layer.querySelector(".backdrop").onclick = closeSheet;
  $("sh-x").onclick = closeSheet;
  if (wire) wire();
}
function closeSheet() {
  var layer = $("sheet-layer");
  layer.hidden = true;
  layer.innerHTML = "";
}
/* 存檔中要把按鈕鎖住，不然手機上很容易連點兩下送出兩筆 */
function runSave(btn, what, mutate) {
  if (btn) { btn.disabled = true; btn.textContent = "存檔中…"; }
  var undo = JSON.stringify(ST.P);
  try { mutate(); } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "存起來"; }
    return toast(String(e.message || e), true);
  }
  closeSheet();
  save(what).catch(function (e) {
    ST.P = JSON.parse(undo);   // 沒存出去就退回原狀，畫面不要騙人
    render();
    toast(String(e.message || e), true);
  });
}

function picksHtml(id, list, cur, isTheme) {
  return '<div class="picks' + (isTheme ? " themes" : "") + '" id="' + id + '">' +
    list.map(function (v) {
      return '<button type="button" data-v="' + esc(v) + '" class="' + (v === cur ? "on" : "") + '"' +
        (isTheme ? ' style="background:' + grad(v) + '"' : "") + '>' + (isTheme ? "" : esc(v)) + '</button>';
    }).join("") + '</div>';
}
function wirePicks(id, onPick) {
  var box = $(id);
  if (!box) return;
  Array.prototype.forEach.call(box.querySelectorAll("button"), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(box.querySelectorAll("button"), function (x) { x.className = ""; });
      b.className = "on";
      onPick(b.getAttribute("data-v"));
    };
  });
}
function checksHtml(id, items, checkedIds) {
  return '<div class="checks" id="' + id + '">' + items.map(function (it) {
    var on = checkedIds.indexOf(it.id) >= 0;
    return '<label class="' + (on ? "on" : "") + '"><input type="checkbox" value="' + esc(it.id) + '"' +
      (on ? " checked" : "") + '><span>' + esc(it.label) + '</span></label>';
  }).join("") + '</div>';
}
function wireChecks(id) {
  var box = $(id);
  if (!box) return;
  Array.prototype.forEach.call(box.querySelectorAll("input"), function (i) {
    i.onchange = function () { i.parentNode.className = i.checked ? "on" : ""; };
  });
}
function checkedValues(id) {
  var box = $(id);
  return box ? Array.prototype.slice.call(box.querySelectorAll("input:checked")).map(function (i) { return i.value; }) : [];
}
function actsHtml(goLabel) {
  return '<div class="sheet-acts"><button class="cancel" id="sh-cancel">算了</button>' +
    '<button class="go" id="sh-go">' + esc(goLabel || "存起來") + '</button></div>';
}
function wireActs(onGo) {
  $("sh-cancel").onclick = closeSheet;
  $("sh-go").onclick = function () { onGo($("sh-go")); };
}

/* ---------- 成員 ---------- */
function userMenu(u) {
  if (!u) return;
  openSheet(u.emoji + " " + u.name,
    '<div class="menu-list">' +
      '<button id="m-edit">✏️ 改名字與樣子</button>' +
      '<button id="m-pw">🔑 換一組密碼</button>' +
      '<button id="m-apps">📦 他可以用哪些 App</button>' +
      '<button class="danger" id="m-del">🗑 把這個人刪掉</button>' +
    '</div>',
    function () {
      $("m-edit").onclick = function () { userSheet(u); };
      $("m-pw").onclick = function () { passwordSheet(u); };
      $("m-apps").onclick = function () { userAppsSheet(u); };
      $("m-del").onclick = function () {
        confirmSheet("刪掉「" + u.name + "」？",
          "他的密碼就再也解不開任何 App 了。已經記在他手機裡的金鑰會在下次開 App 時失效。",
          "刪掉", function (btn) {
            runSave(btn, "刪掉 " + u.name, function () {
              ST.P.users = ST.P.users.filter(function (x) { return x.id !== u.id; });
            });
          });
      };
    });
}

function userSheet(u) {
  var f = {
    name: u ? u.name : "",
    emoji: u ? u.emoji : "🧑",
    theme: u ? u.theme : "night"
  };
  openSheet(u ? "改「" + u.name + "」" : "加一個人",
    '<label class="field"><span class="fl">名字</span>' +
      '<input id="f-name" type="text" value="' + esc(f.name) + '" placeholder="他要在解鎖畫面看到的名字"></label>' +
    '<div class="field"><span class="fl">頭像</span>' + picksHtml("f-emoji", EMOJIS, f.emoji) + '</div>' +
    '<div class="field"><span class="fl">顏色</span>' + picksHtml("f-theme", THEME_KEYS, f.theme, true) + '</div>' +
    (u ? "" :
      '<label class="field"><span class="fl">給他一組密碼</span>' +
      '<input id="f-pw" type="text" autocomplete="off" placeholder="等一下唸給他聽">' +
      '<span class="hint">存下去之後連你也看不到它 —— 系統只留下它派生出來的金鑰。忘了就重設一組。</span></label>') +
    actsHtml(),
    function () {
      wirePicks("f-emoji", function (v) { f.emoji = v; });
      wirePicks("f-theme", function (v) { f.theme = v; });
      wireActs(function (btn) {
        var name = $("f-name").value.trim();
        if (!name) return toast("先幫他取個名字", true);
        var pw = $("f-pw") ? $("f-pw").value : "";
        if (!u && !pw) return toast("先設一組密碼給他", true);

        if (u) {
          return runSave(btn, "改了 " + name, function () {
            u.name = name; u.emoji = f.emoji; u.theme = f.theme;
          });
        }
        /* 新成員要派生金鑰，PBKDF2 60 萬次在手機上要跑個一兩秒 */
        btn.disabled = true; btn.textContent = "產生金鑰中…";
        var salt = randomB64(16);
        pbkdf2(pw, salt, ITER).then(function (dk) {
          runSave(btn, "加了 " + name, function () {
            ST.P.users.push({
              id: uniqueId(newId("u"), ST.P.users.map(function (x) { return x.id; })),
              name: name, emoji: f.emoji, theme: f.theme,
              salt: salt, dk: bytesToB64(dk),
              /* 要管的只有成員：新人預設所有 App 都給，要收再到「他可以用哪些 App」取消 */
              apps: ST.P.apps.map(function (a) { return a.id; })
            });
          });
        }, function (e) {
          btn.disabled = false; btn.textContent = "存起來";
          toast(String(e.message || e), true);
        });
      });
    });
}

function passwordSheet(u) {
  openSheet("換「" + u.name + "」的密碼",
    '<p class="note">換密碼＝重新派生金鑰，再把他所有 App 的金鑰用新密碼重新加密一次。' +
      '他手機上記著的舊金鑰會自動失效，下次開 App 會請他重新解鎖。</p>' +
    '<label class="field"><span class="fl">新密碼</span>' +
      '<input id="f-pw" type="text" autocomplete="off" placeholder="等一下唸給他聽"></label>' +
    actsHtml("換掉"),
    function () {
      wireActs(function (btn) {
        var pw = $("f-pw").value;
        if (!pw) return toast("先輸入新密碼", true);
        btn.disabled = true; btn.textContent = "產生金鑰中…";
        var salt = randomB64(16);
        pbkdf2(pw, salt, ITER).then(function (dk) {
          runSave(btn, "換了 " + u.name + " 的密碼", function () {
            u.salt = salt; u.dk = bytesToB64(dk);
          });
        }, function (e) {
          btn.disabled = false; btn.textContent = "換掉";
          toast(String(e.message || e), true);
        });
      });
    });
}

function userAppsSheet(u) {
  var items = ST.P.apps.map(function (a) { return { id: a.id, label: a.emoji + " " + a.name }; });
  if (!items.length) {
    return openSheet("「" + u.name + "」可以用哪些 App",
      '<div class="empty"><div class="big">📦</div><p>還沒有登記任何 App。</p></div>');
  }
  openSheet("「" + u.name + "」可以用哪些 App",
    checksHtml("f-apps", items, u.apps || []) + actsHtml(),
    function () {
      wireChecks("f-apps");
      wireActs(function (btn) {
        var ids = checkedValues("f-apps");
        runSave(btn, "改了 " + u.name + " 的權限", function () { u.apps = ids; });
      });
    });
}

/* ---------- App ---------- */
function appMenu(a) {
  if (!a) return;
  openSheet(a.emoji + " " + a.name,
    '<div class="menu-list">' +
      '<button id="m-edit">✏️ 改名字與樣子</button>' +
      '<button id="m-token">🔑 換一把金鑰</button>' +
      '<button id="m-users">🧑 誰可以用</button>' +
      '<button class="danger" id="m-del">🗑 把這個 App 拿掉</button>' +
    '</div>',
    function () {
      $("m-edit").onclick = function () { appSheet(a); };
      $("m-token").onclick = function () { appTokenSheet(a); };
      $("m-users").onclick = function () { appUsersSheet(a); };
      $("m-del").onclick = function () {
        confirmSheet("把「" + a.name + "」拿掉？",
          "所有人都會失去這個 App 的金鑰。那把 PAT 本身還在 GitHub 上，要收回去記得另外去撤銷。",
          "拿掉", function (btn) {
            runSave(btn, "拿掉 " + a.name, function () {
              ST.P.apps = ST.P.apps.filter(function (x) { return x.id !== a.id; });
              ST.P.users.forEach(function (u) {
                u.apps = (u.apps || []).filter(function (x) { return x !== a.id; });
              });
            });
          });
      };
    });
}

function appSheet(a) {
  var f = { emoji: a ? a.emoji : "📦" };
  var donor = null;
  for (var i = ST.P.apps.length - 1; i >= 0; i--) if (ST.P.apps[i].token) { donor = ST.P.apps[i]; break; }
  openSheet(a ? "改「" + a.name + "」" : "登記一個 App",
    '<label class="field"><span class="fl">名字</span>' +
      '<input id="f-name" type="text" value="' + esc(a ? a.name : "") + '" placeholder="旅途手帳"></label>' +
    (a ? '<div class="field"><span class="fl">代號</span><div class="keyline">' + esc(a.id) + '</div>' +
         '<span class="hint">代號登記好就不能改（App 前端是照它去找金鑰的）。</span></div>'
       : '<label class="field"><span class="fl">代號</span>' +
         '<input id="f-id" type="text" inputmode="latin" autocapitalize="off" placeholder="travel-book">' +
         '<span class="hint">要跟那個 App 前端 <code>Keyring.init({appId:…})</code> 寫的一模一樣，只能用英數與 - _ 。</span></label>') +
    '<label class="field"><span class="fl">網址（選填）</span>' +
      '<input id="f-url" type="url" inputmode="url" value="' + esc(a ? (a.url || "") : "") + '" placeholder="https://…"></label>' +
    '<div class="field"><span class="fl">圖示</span>' + picksHtml("f-emoji", APP_EMOJIS, f.emoji) + '</div>' +
    (a ? "" :
      '<label class="field"><span class="fl">金鑰（選填）</span>' +
      '<textarea id="f-token" autocapitalize="off" autocomplete="off" placeholder="' +
        (donor ? "留空就沿用「" + esc(donor.name) + "」那一把" : "第一個 App，這次一定要貼一把進來") + '"></textarea>' +
      '<span class="hint">' + (donor
        ? "不填就沿用你最近貼的那一把（Benson 的 App 多半共用同一把）。"
        : "fine-grained PAT，只授權那一個 repo 的 Contents。") + '</span></label>') +
    actsHtml(),
    function () {
      wirePicks("f-emoji", function (v) { f.emoji = v; });
      wireActs(function (btn) {
        var name = $("f-name").value.trim();
        if (!name) return toast("先給它一個名字", true);
        var url = $("f-url").value.trim();
        if (a) {
          return runSave(btn, "改了 " + name, function () {
            a.name = name; a.emoji = f.emoji; a.url = url;
          });
        }
        var wanted = slugify($("f-id").value || name);
        if (wanted && appById(wanted)) {
          return toast("已經有一個代號叫「" + wanted + "」的 App 了", true);
        }
        var token = $("f-token").value.trim();
        if (!token) {
          if (!donor) return toast("這是第一個 App，還沒有金鑰可以沿用 —— 這次要貼一把進來", true);
          token = donor.token;
        }
        runSave(btn, "登記了 " + name, function () {
          var id = uniqueId(wanted || newId("app"), ST.P.apps.map(function (x) { return x.id; }));
          ST.P.apps.push({ id: id, name: name, emoji: f.emoji, url: url, token: token });
          /* 新 App 直接給所有現有成員，要收再到「誰可以用」取消 */
          ST.P.users.forEach(function (u) {
            if (!Array.isArray(u.apps)) u.apps = [];
            if (u.apps.indexOf(id) < 0) u.apps.push(id);
          });
        });
      });
    });
}

function appTokenSheet(a) {
  openSheet("換「" + a.name + "」的金鑰",
    '<p class="note">貼新的進去，所有人的密文都會用新金鑰重產一次。' +
      '他們不用重新解鎖 —— 裝置記著的是派生金鑰，下次開 App 會自動換過去。</p>' +
    '<label class="field"><span class="fl">新的 GitHub 金鑰</span>' +
      '<textarea id="f-token" autocapitalize="off" autocomplete="off" placeholder="github_pat_…"></textarea>' +
      '<span class="hint">現在是 ' + esc(a.token ? maskToken(a.token) : "沒有金鑰") + '</span></label>' +
    actsHtml("換掉"),
    function () {
      wireActs(function (btn) {
        var token = $("f-token").value.trim();
        if (!token) return toast("先貼上新的金鑰", true);
        runSave(btn, "換了 " + a.name + " 的金鑰", function () { a.token = token; });
      });
    });
}

function appUsersSheet(a) {
  var items = ST.P.users.map(function (u) { return { id: u.id, label: u.emoji + " " + u.name }; });
  if (!items.length) {
    return openSheet("誰可以用「" + a.name + "」",
      '<div class="empty"><div class="big">🧑</div><p>還沒有任何成員。</p></div>');
  }
  var cur = ST.P.users.filter(function (u) { return (u.apps || []).indexOf(a.id) >= 0; })
    .map(function (u) { return u.id; });
  openSheet("誰可以用「" + a.name + "」",
    checksHtml("f-users", items, cur) + actsHtml(),
    function () {
      wireChecks("f-users");
      wireActs(function (btn) {
        var ids = checkedValues("f-users");
        runSave(btn, "改了 " + a.name + " 的成員", function () {
          ST.P.users.forEach(function (u) {
            var has = (u.apps || []).indexOf(a.id) >= 0;
            var want = ids.indexOf(u.id) >= 0;
            if (want && !has) u.apps.push(a.id);
            if (!want && has) u.apps = u.apps.filter(function (x) { return x !== a.id; });
          });
        });
      });
    });
}

/* ---------- 設定 ---------- */
function confirmSheet(title, note, goLabel, onGo) {
  openSheet(title,
    '<p class="note">' + esc(note) + '</p>' +
    '<div class="sheet-acts"><button class="cancel" id="sh-cancel">算了</button>' +
      '<button class="go" id="sh-go">' + esc(goLabel) + '</button></div>',
    function () {
      $("sh-cancel").onclick = closeSheet;
      $("sh-go").onclick = function () { onGo($("sh-go")); };
    });
}

function settingsSheet() {
  openSheet("設定",
    '<div class="menu-list">' +
      '<button id="s-gh">🔐 GitHub 金鑰　' + esc(ghToken() ? maskToken(ghToken()) : "還沒設") + '</button>' +
      '<button id="s-pair">📱 這台裝置的配對碼</button>' +
      '<button id="s-lock">🔒 鎖起來</button>' +
    '</div>',
    function () {
      $("s-gh").onclick = askGithubToken;
      $("s-pair").onclick = function () {
        openSheet("這台裝置的配對碼",
          '<p class="note">要在另一支手機上開這個後台，把下面這串貼過去（或直接開這個連結）。' +
            '配對碼不是密碼 —— 兩個都要有才解得開。</p>' +
          '<div class="field"><span class="fl">配對碼</span><div class="keyline">' + esc(ST.pairing) + '</div></div>' +
          '<div class="field"><span class="fl">帶配對碼的連結</span><div class="keyline">' +
            esc(location.origin + location.pathname + "#pair=" + ST.pairing) + '</div></div>' +
          '<div class="sheet-acts"><button class="go" id="sh-copy">複製連結</button></div>',
          function () {
            $("sh-copy").onclick = function () {
              var link = location.origin + location.pathname + "#pair=" + ST.pairing;
              (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
                .then(function () { toast("複製好了"); }, function () { toast("複製不了，長按上面那行自己選", true); });
            };
          });
      };
      $("s-lock").onclick = function () { closeSheet(); lock(); };
    });
}

function askGithubToken() {
  openSheet("GitHub 金鑰",
    '<p class="note">手機這邊要靠它把改動寫回 ' + esc(CFG.owner + "/" + CFG.repo) + '。' +
      '用 fine-grained PAT，Repository access 只勾這一個 repo，權限只給 <b>Contents: Read and write</b>。' +
      '它會跟著加密進 vault.json，不會出現在任何明文檔案裡。</p>' +
    '<label class="field"><span class="fl">金鑰</span>' +
      '<textarea id="f-token" autocapitalize="off" autocomplete="off" placeholder="github_pat_…"></textarea>' +
      '<span class="hint">現在是 ' + esc(ghToken() ? maskToken(ghToken()) : "還沒設") + '</span></label>' +
    actsHtml("存起來"),
    function () {
      wireActs(function (btn) {
        var token = $("f-token").value.trim();
        if (!token) return toast("先貼上金鑰", true);
        /* 先拿它去問一次 GitHub，別等到存檔才發現這把不能寫 */
        btn.disabled = true; btn.textContent = "驗證中…";
        gh("/git/ref/heads/" + CFG.branch, "GET", null, token).then(function () {
          if (!ST.P.github) ST.P.github = {};
          ST.P.github.token = token;
          ST.P.github.owner = CFG.owner;
          ST.P.github.repo = CFG.repo;
          ST.P.github.branch = CFG.branch;
          closeSheet();
          save("換了 GitHub 金鑰").catch(function (e) { toast(String(e.message || e), true); });
        }, function (e) {
          btn.disabled = false; btn.textContent = "存起來";
          toast(String(e.message || e), true);
        });
      });
    });
}

/* ------------------------------------------------------------------ */
/* 開場                                                                */
/* ------------------------------------------------------------------ */
(function boot() {
  try { ST.pairing = localStorage.getItem(NS + "pairing") || ""; } catch (e) { ST.pairing = ""; }
  /* 帶配對碼的連結：#pair=XXXX-XXXX-XXXX-XXXX。收下就把它從網址列擦掉，不要留在歷史紀錄裡 */
  var m = /[#&]pair=([0-9A-Za-z-]+)/.exec(location.hash || "");
  if (m) {
    ST.pairing = normalizePairing(m[1]);
    try { localStorage.setItem(NS + "pairing", ST.pairing); } catch (e) {}
    history.replaceState(null, "", location.pathname + location.search);
  }
  renderLock();
})();
