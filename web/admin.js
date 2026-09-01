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
  tab: "apps",         /* 進來先看到 App：管理主控台的主場（2026-08-28） */
  who: "",           /* 這台裝置是誰在用（只寫進 commit message 的 by:，不進任何公開檔） */
  log: null,          /* 近況（變更紀錄），第一次切過去才抓 */
  logBusy: false,
  pushed: {},         /* repo -> pushed_at（未認證的 GitHub API，30 分鐘快取） */
  pushedAt: 0,
  openLog: {},        /* 哪幾張 App 卡片被展開了 */
  appLog: {},         /* appId -> 最近 3 筆 commit */
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
  var apps = p.apps.map(function (a) {
    var o = { id: a.id, name: a.name, emoji: a.emoji };
    /* 開場外觀：公開明文，沒設定就整個鍵都不要出現（跟 server.js 的 buildKeyring 同一條規則） */
    var sp = KF.normSplash(a.splash);
    if (sp) o.splash = sp;
    return o;
  });
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

/* 啟動頁的公開清單 apps.json。
 * ⚠️ **產生器只有一份**：client/keyring-fields.js 的 buildApps()，電腦端呼叫的是同一支。
 *    這個 repo 已經因為「同一條規則活在兩套實作裡」出過事（金鑰沿用只修了電腦端），
 *    所以這裡刻意只是一層薄薄的轉呼叫 —— 不要在這裡「順手」加欄位或改順序。
 *    tools/check-public.js 的 E 組會比對兩端產出**逐位元組相同**。 */
function appsFileText(p, stamp) {
  return KF.appsJsonText({ apps: (p && p.apps) || [], generatedAt: stamp });
}

/* ------------------------------------------------------------------ */
/* 金鑰到期偵測（手機端）                                               */
/* ------------------------------------------------------------------ */
/* ⛔ 鐵律：拿**那個 App 自己的那把 token**打**它自己的 repo**。
 *    不可以拿鑰匙圈那把（ghToken()）去測別的 App —— 那等於讓金鑰跨 App 流動。
 * ⛔ 明文只在這台裝置的記憶體裡用一次：不寫進 localStorage、不進 apps.json、不進畫面。 */
function checkAppKey(a) {
  var token = String((a && a.token) || "").trim();
  if (!token) return Promise.resolve({ changed: false, message: "這個 App 沒有金鑰，沒有東西可以測" });
  if (!KF.looksLikeGithubToken(token)) {
    return Promise.resolve({ changed: false, message: "這個 App 的金鑰不是 GitHub 金鑰，測不到到期日（可以自己填一個）" });
  }
  var repo = KF.normRepo(a.repo) || KF.repoFromUrl(a.url || "");
  var was = JSON.stringify(KF.normKeyExp(a.keyExp));
  var now = nowIso();
  return fetch("https://api.github.com/" + (repo ? "repos/" + repo : "user"), {
    headers: { "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json" }
  }).then(function (r) {
    var exp = KF.expiryFromHeader(r.headers.get("github-authentication-token-expiration") || "");
    var prev = KF.normKeyExp(a.keyExp);
    var msg;
    if (r.ok) {
      a.keyExp = exp
        ? { expiresAt: exp, source: "auto", checkedAt: now, state: "ok" }
        : { expiresAt: null, source: "auto", checkedAt: now, state: "none" };
      msg = exp ? ("這把到 " + exp + " 過期") : "這把不會過期";
    } else if (r.status === 401) {
      a.keyExp = { expiresAt: (prev && prev.expiresAt) || null, source: "auto", checkedAt: now, state: "expired" };
      msg = "GitHub 說這把已經無效了（過期或被撤銷）";
    } else {
      /* 403／404：**測不到，不是沒事**。手動填過的值不覆蓋。 */
      a.keyExp = prev ? { expiresAt: prev.expiresAt, source: prev.source, checkedAt: now, state: prev.state }
                      : { expiresAt: null, source: "auto", checkedAt: now, state: "unknown" };
      msg = "這次測不到（GitHub 回 " + r.status + "），維持上一次的結果";
    }
    return { changed: JSON.stringify(KF.normKeyExp(a.keyExp)) !== was, message: msg };
  }, function () {
    return { changed: false, message: "連不到 GitHub，這次沒測到" };
  });
}

/* 各 App 的「上次更新時間」：一個未認證的請求就拿得到全部（60 次/小時/IP）。
 * 跟啟動頁共用同一份 localStorage 快取（同一個鍵、同樣 30 分鐘）。 */
var PUSH_KEY = "keyring.launch.pushed";
var PUSH_TTL = 30 * 60 * 1000;
function loadPushed(force) {
  var cache = null;
  try { cache = JSON.parse(localStorage.getItem(PUSH_KEY) || "null"); } catch (e) { cache = null; }
  if (!force && cache && cache.at && (Date.now() - cache.at) < PUSH_TTL) {
    ST.pushed = cache.map || {}; ST.pushedAt = cache.at;
    return Promise.resolve(false);
  }
  return fetch("https://api.github.com/users/" + CFG.owner + "/repos?sort=pushed&per_page=100", {
    headers: { "Accept": "application/vnd.github+json" }
  }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function (list) {
    var map = {};
    (list || []).forEach(function (x) { if (x && x.full_name) map[x.full_name] = x.pushed_at; });
    ST.pushed = map; ST.pushedAt = Date.now();
    try { localStorage.setItem(PUSH_KEY, JSON.stringify({ at: ST.pushedAt, map: map })); } catch (e) {}
    return true;
  }, function () {
    /* 拿不到更新時間不是錯誤：卡片照常，那一行顯示「—」 */
    if (cache) { ST.pushed = cache.map || {}; ST.pushedAt = cache.at; }
    return false;
  });
}
function agoOf(iso) {
  var t = Date.parse(iso || "");
  if (isNaN(t)) return "—";
  var d = Date.now() - t, H = 3600e3, D = 86400e3;
  if (d < 90e3) return "剛剛";
  if (d < H) return Math.max(1, Math.round(d / 60e3)) + " 分鐘前";
  if (d < 22 * H) return Math.round(d / H) + " 小時前";
  if (d < 44 * H) return "昨天";
  if (d < 8 * D) return Math.round(d / D) + " 天前";
  var x = new Date(t);
  return (x.getMonth() + 1) + "/" + x.getDate();
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
function save(what, diffs) {
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
      /* 三個檔案包成同一個 commit。apps.json 是啟動頁在讀的公開清單，
       * 產不出來（名字／圖示裡被貼了金鑰）就**整筆存檔失敗**，不要靜靜跳過它 ——
       * 靜靜跳過的話啟動頁會停在舊清單，而他以為存好了。 */
      return pushFiles([
        { path: "keyring.json", text: JSON.stringify(keyring, null, 2) + "\n" },
        { path: "vault.json", text: JSON.stringify(vault, null, 2) + "\n" },
        { path: "apps.json", text: appsFileText(ST.P, stamp) }
      ], KF.commitMessage({ action: what, diffs: diffs, by: ST.who, via: "手機後台" }));
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
    afterUnlock();
  }).catch(function (e) {
    ST.keyBytes = null;
    lockErr = String((e && e.message) || e);
    renderLock();
  });
}

/* 解鎖之後：① 啟動頁帶進來的深連結直接端出那張 sheet；
 *           ② 還沒寫過「這台是誰在用」就問一次（只問一次，按「先不要」也算問過）；
 *           ③ 背景把每把金鑰的到期日重測一輪（規格 4-2 的②），有變才存。 */
function afterUnlock() {
  var dl = ST.deepLink;
  ST.deepLink = null;
  if (dl) {
    var a = appById(dl.app);
    if (a) {
      ST.tab = "apps"; render();
      if (dl.do === "key") return appTokenSheet(a);
      return appMenu(a);
    }
    toast("找不到那個 App，可能已經改名或拿掉了", true);
  }
  var asked = "";
  try { asked = localStorage.getItem(NS + "whoAsked") || ""; } catch (e) { asked = ""; }
  if (!ST.who && !asked) return whoSheet(false);
  backgroundCheckKeys();
}
/* 背景重測：安靜地做，結果變了才存一筆（不彈任何東西打斷他） */
function backgroundCheckKeys() {
  var apps = (ST.P.apps || []).filter(function (a) { return a.token && KF.looksLikeGithubToken(a.token); });
  if (!apps.length) return;
  var changed = false, chain = Promise.resolve();
  apps.forEach(function (a) {
    chain = chain.then(function () {
      return checkAppKey(a).then(function (r) { changed = changed || r.changed; });
    });
  });
  chain.then(function () {
    if (!changed) return render();
    save("重新檢查了金鑰的到期日").catch(function () { /* 存不出去就算了，下次再測 */ });
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
      '<button data-tab="apps" class="' + (ST.tab === "apps" ? "on" : "") + '">App</button>' +
      '<button data-tab="users" class="' + (ST.tab === "users" ? "on" : "") + '">成員</button>' +
      '<button data-tab="log" class="' + (ST.tab === "log" ? "on" : "") + '">近況</button>' +
    '</div>' +
    (ST.tab === "users" ? usersHtml() : ST.tab === "log" ? logHtml() : appsHtml()) +
    '<p class="ad-foot">改了就直接存到 GitHub，沒有草稿狀態。<br>' +
      '這台裝置記錄成「' + esc(ST.who || "沒寫名字") + '」（近況那頁的「誰改的」）<br>' +
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
  /* 卡片展開「最近改了什麼」：**只在展開的時候才打那一個請求** */
  Array.prototype.forEach.call(el.querySelectorAll("[data-log]"), function (b) {
    b.onclick = function () {
      var id = b.getAttribute("data-log");
      ST.openLog[id] = !ST.openLog[id];
      render();
      if (ST.openLog[id] && !ST.appLog[id]) loadAppLog(id);
    };
  });
  if ($("bt-more")) $("bt-more").onclick = function () { loadLog((ST.log || []).length + 30); };
  if ($("bt-checkall")) $("bt-checkall").onclick = function () { checkAllKeys($("bt-checkall")); };
  /* 更新時間：畫面先出來，這個晚一點到（拿不到也不影響清單） */
  if (ST.tab === "apps" && !ST.pushedAt) {
    loadPushed(false).then(function (fresh) { if (fresh || ST.pushedAt) render(); });
  }
  if (ST.tab === "log" && !ST.log && !ST.logBusy) loadLog(30);
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

/* 啟動頁的磚塊順序是固定的（Benson 拍板），後台也照同一個順序列，
 * 免得他在後台看到的排法跟啟動頁不一樣。規則跟 KF.buildApps() 一致。 */
function appsInOrder() {
  return ST.P.apps.map(function (a, i) {
    return { a: a, i: i, o: (typeof a.order === "number" && isFinite(a.order)) ? a.order : i };
  }).sort(function (x, y) { return x.o === y.o ? x.i - y.i : x.o - y.o; }).map(function (r) { return r.a; });
}
/* 到期 chip。文案在 KF.keyLabel()（啟動頁、兩個後台同一份） */
function keyChipHtml(a) {
  if (!a.token) return '<span class="chip none">只有連結</span>';
  var st = KF.keyExpState(a.keyExp, nowIso());
  var cls = st.state === "expired" ? "bad" : (st.state === "soon" ? "warn" : (st.state === "unknown" ? "none" : "ok"));
  return '<span class="chip ' + cls + '">' + esc(KF.keyLabel(st)) + '</span>';
}
function appsHtml() {
  if (!ST.P.apps.length) {
    return '<div class="empty"><div class="big">📦</div>' +
      '<p>還沒有登記任何 App。<br>登記的代號要跟那個 App 前端的 appId 一模一樣。</p></div>' +
      '<button class="addcard" id="add-app">＋ 登記一個 App</button>';
  }
  return appsInOrder().map(function (a) {
    var who = ST.P.users.filter(function (u) { return (u.apps || []).indexOf(a.id) >= 0; });
    var chips = who.map(function (u) { return '<span class="chip">' + esc(u.emoji + " " + u.name) + '</span>'; }).join("");
    var repo = KF.normRepo(a.repo) || KF.repoFromUrl(a.url || "");
    var open = !!ST.openLog[a.id];
    var rows = ST.appLog[a.id];
    return '<div class="rowcard stack"><div class="rc-top">' +
      '<div class="rc-face" style="background:#efe8db; color:#6b6154">' + esc(a.emoji || "📦") + '</div>' +
      '<div class="rc-bd"><b>' + esc(a.name) + '</b>' +
        (a.url ? '<span class="rc-url">' + esc(String(a.url).replace(/^https?:\/\//, "")) + '</span>'
               : '<span class="rc-url miss">⚠ 還沒填網址，啟動頁點不開</span>') +
        '<div class="chips">' + keyChipHtml(a) +
          '<span class="chip">' + (repo ? "更新於 " + esc(agoOf(ST.pushed[repo])) : "沒有 repo") + '</span>' +
          (a.public ? '<span class="chip warn">公開模式</span>' : "") +
          (chips || '<span class="chip none">還沒給任何人</span>') +
        '</div>' +
        (KF.normSplash(a.splash) ? '<div class="keyline">🎬 ' + esc(splashSummary(KF.normSplash(a.splash))) + '</div>' : '') +
        '<div class="keyline">' + esc(a.id) + ' · ' +
          esc(a.token ? KF.maskSummary(a.fields, a.token, maskToken) : "沒有金鑰") + '</div>' +
      '</div>' +
      '<button class="rc-more" data-app="' + esc(a.id) + '">⋯</button>' +
      '</div>' +
      (repo
        ? '<button class="rc-open" data-log="' + esc(a.id) + '">' + (open ? "收起 ▴" : "最近改了什麼 ▾") + '</button>' +
          (open ? '<div class="rc-log">' + (rows
            ? (rows.length ? '<ul>' + rows.map(function (r) {
                return '<li><i>' + esc(agoOf(r.at)) + '</i>' + esc(r.title) + '</li>';
              }).join("") + '</ul>' : '<p>這個 repo 還沒有 commit。</p>')
            : '<p>抓取中…</p>') + '</div>' : "")
        : "") +
    '</div>';
  }).join("") +
    '<button class="addcard" id="add-app">＋ 登記一個 App</button>' +
    '<button class="loadmore" id="bt-checkall">🔄 重新檢查全部金鑰的到期日</button>';
}

/* ------------------------------------------------------------------ */
/* 近況（變更紀錄）                                                     */
/* ------------------------------------------------------------------ */
/* 手機端的資料來源是 GitHub 的 commits API（帶既有的鑰匙圈 PAT），
 * 電腦端是 git log —— 兩邊都**只解析 message**，畫面組法完全一樣。 */
function loadLog(n) {
  ST.logBusy = true;
  return gh("/commits?path=keyring.json&per_page=" + Math.min(100, n || 30)).then(function (list) {
    ST.log = (list || []).map(function (c) {
      var p = KF.parseCommitMessage((c.commit && c.commit.message) || "");
      return { sha: (c.sha || "").slice(0, 7), at: (c.commit && c.commit.author && c.commit.author.date) || "",
        title: p.title, by: p.by, via: p.via, tagged: p.tagged, otherFiles: null };
    });
    ST.logBusy = false;
    render();
  }, function (e) {
    ST.logBusy = false;
    ST.log = [];
    ST.logErr = String((e && e.message) || e);
    render();
  });
}
function loadAppLog(id) {
  var a = appById(id);
  var repo = a && (KF.normRepo(a.repo) || KF.repoFromUrl(a.url || ""));
  if (!repo) { ST.appLog[id] = []; return render(); }
  /* 未認證就好：這是公開資料，不必把鑰匙圈那把 PAT 送去別人的 repo */
  return fetch("https://api.github.com/repos/" + repo + "/commits?per_page=3", {
    headers: { "Accept": "application/vnd.github+json" }
  }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function (list) {
    ST.appLog[id] = (list || []).map(function (c) {
      return { at: (c.commit && c.commit.author && c.commit.author.date) || "",
        title: String((c.commit && c.commit.message) || "").split("\n")[0] };
    });
    render();
  }, function () {
    ST.appLog[id] = [];
    render();
  });
}
function dayLabel(iso) {
  var t = Date.parse(iso || "");
  if (isNaN(t)) return "不知道什麼時候";
  var a = new Date(t), now = new Date();
  if (a.toDateString() === now.toDateString()) return "今天";
  if (a.toDateString() === new Date(now.getTime() - 86400e3).toDateString()) return "昨天";
  return (a.getMonth() + 1) + " 月 " + a.getDate() + " 日";
}
function clockOf(iso) {
  var t = Date.parse(iso || "");
  if (isNaN(t)) return "";
  var d = new Date(t);
  return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
}
/* 兩個後台共用這一支的結構（電腦端是同樣的 markup），資料形狀一樣：
 * {at, title, by, via, tagged, otherFiles} */
function logRowsHtml(rows, me) {
  var h = "", last = "";
  rows.forEach(function (e) {
    var d = dayLabel(e.at);
    if (d !== last) { h += (last ? "</ul>" : "") + '<p class="day">' + esc(d) + '</p><ul class="tl">'; last = d; }
    var who = e.by ? esc(e.by) + "（" + esc(e.via) + "）" : esc(e.via);
    h += '<li class="' + (me && e.by === me ? "me" : "") + '">' +
      '<div class="w"><b>' + who + '</b><span>' + esc(clockOf(e.at)) + '</span></div>' +
      '<div class="t">' + esc(e.title) + '</div>' +
      (e.otherFiles ? '<div class="x">這次同時改到 ' + e.otherFiles + ' 個其他檔案</div>' : "") +
      '</li>';
  });
  return h + (last ? "</ul>" : "");
}
function logHtml() {
  if (ST.logBusy && !ST.log) return '<div class="empty"><div class="big">🕘</div><p>正在跟 GitHub 要紀錄…</p></div>';
  if (!ST.log || !ST.log.length) {
    return '<div class="empty"><div class="big">🕘</div><p>' +
      esc(ST.logErr || "還沒有任何變更紀錄。") + '</p></div>';
  }
  return '<p class="ad-foot" style="text-align:left; padding:0 4px 10px">鑰匙圈被誰改過。存檔就是一筆紀錄，改不掉也刪不掉。</p>' +
    logRowsHtml(ST.log, ST.who) +
    '<button class="loadmore" id="bt-more">看更早的</button>';
}
/* 「重新檢查全部」：一個 App 一個請求、各用各的 token */
function checkAllKeys(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "檢查中…"; }
  var apps = ST.P.apps.filter(function (a) { return !!a.token; });
  var changed = false, lines = [];
  var chain = Promise.resolve();
  apps.forEach(function (a) {
    chain = chain.then(function () {
      return checkAppKey(a).then(function (r) {
        changed = changed || r.changed;
        lines.push(a.name + "：" + r.message);
      });
    });
  });
  return chain.then(function () {
    if (btn) { btn.disabled = false; btn.textContent = "🔄 重新檢查全部金鑰的到期日"; }
    if (!changed) { render(); return toast("檢查完了，結果沒有變"); }
    /* 結果變了才存 —— 否則每按一次就多一筆什麼都沒改的紀錄 */
    save("重新檢查了所有金鑰的到期日").catch(function (e) { toast(String(e.message || e), true); });
  });
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
  /* 結構差異是備援：what 沒給人話時，commit 的第一行才用它推 */
  var diffs = KF.summarizeChange(JSON.parse(undo), ST.P);
  save(what, diffs).catch(function (e) {
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
      '<button id="m-exp">⏰ 金鑰到期日</button>' +
      '<button id="m-order">↕️ 在啟動頁的位置</button>' +
      '<button id="m-fields">🧩 金鑰欄位（分成幾格）</button>' +
      '<button id="m-splash">🎬 開場外觀（啟動畫面）</button>' +
      '<button id="m-public">🌐 公開模式' + (a.public ? '（目前：公開）' : '（目前：要密碼）') + '</button>' +
      '<button id="m-users">🧑 誰可以用</button>' +
      '<button class="danger" id="m-del">🗑 把這個 App 拿掉</button>' +
    '</div>',
    function () {
      $("m-edit").onclick = function () { appSheet(a); };
      $("m-token").onclick = function () { appTokenSheet(a); };
      $("m-exp").onclick = function () { appKeySheet(a); };
      $("m-order").onclick = function () { appOrderSheet(a); };
      $("m-fields").onclick = function () { appFieldsSheet(a); };
      $("m-splash").onclick = function () { appSplashSheet(a); };
      $("m-public").onclick = function () { appPublicSheet(a); };
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

/* ------------------------------------------------------------------ */
/* 多欄位金鑰（共用邏輯在 ../client/keyring-fields.js，跟本機後台同一份）  */
/* 沒有宣告欄位的 App（旅途手帳、食譜本）完全走原本那條路。                */
/* ------------------------------------------------------------------ */
var KF = window.KeyringFields;

/* fs 是 [{key,label,hint,optional}]；redrawFn 是「加一格／刪一格」之後要重畫哪個 sheet */
function fieldsEditorHtml(fs, appId) {
  var rows = fs.map(function (f, i) {
    return '<div class="fieldrow">' +
      '<div class="fr-line">' +
        '<input class="fr-key" id="fe-k' + i + '" value="' + esc(f.key) + '" placeholder="代號 tmdb" autocapitalize="off" spellcheck="false">' +
        '<input class="fr-label" id="fe-l' + i + '" value="' + esc(f.labelHidden ? "" : f.label) +
        '" placeholder="' + (f.labelHidden ? "原本的標題像金鑰、已隱藏——請改成人看的名字" : "標題（TMDB 金鑰）") + '">' +
        '<button type="button" class="fr-del" data-del="' + i + '">✕</button>' +
      '</div>' +
      '<div class="fr-line">' +
        /* hintHidden＝原本的說明看起來像金鑰、已被 API 遮掉。這裡給空字串而不是
         * 遮罩後的警告文字，否則一存檔就把警告字串寫回去、蓋掉原本那串。 */
        '<input class="fr-hint" id="fe-h' + i + '" value="' + esc(f.hintHidden ? "" : f.hint) +
        '" placeholder="' + (f.hintHidden ? "原本的說明像金鑰、已隱藏——存檔會清掉它" : "說明（選填）") + '">' +
        '<label class="fr-opt"><input type="checkbox" id="fe-o' + i + '"' + (f.optional ? " checked" : "") + '> 可留空</label>' +
      '</div></div>';
  }).join("");
  var preset = KF.presetFor(appId || "") || (fs.length ? null : KF.PRESETS[0]);
  return '<div class="field"><span class="fl">金鑰要分成幾格</span>' +
    /* ⚠️ 「這裡不是填金鑰的地方」是踩兩次換來的：這張表單沒有放值的格子，
     *    人會很自然地把金鑰填進最像的那一格（第一次說明、第二次標題）。 */
    '<span class="hint">不設就是一格（旅途手帳、食譜本都是這樣，畫面完全不變）。需要兩把金鑰的 App 就加兩格。<br>' +
    '<b>這裡只是宣告「有哪幾格」，不是填金鑰的地方</b>——存完之後按「換金鑰」才是貼金鑰的地方。</span>' +
    '<div id="fe-rows">' + rows + '</div>' +
    '<div class="fr-acts">' +
      (fs.length < KF.MAX_FIELDS ? '<button type="button" id="fe-add">＋ 加一格</button>' : '') +
      (preset ? '<button type="button" id="fe-preset">套用「' + esc(preset.label) + '」</button>' : '') +
      (fs.length ? '<button type="button" id="fe-clear">改回一格</button>' : '') +
    '</div></div>';
}
/* 把畫面上的值收回陣列（加一格／存檔前都要先做，不然他打的字會不見） */
function readFieldsEditor(fs) {
  return fs.map(function (f, i) {
    return {
      key: $("fe-k" + i) ? $("fe-k" + i).value : f.key,
      label: $("fe-l" + i) ? $("fe-l" + i).value : f.label,
      hint: $("fe-h" + i) ? $("fe-h" + i).value : f.hint,
      optional: $("fe-o" + i) ? $("fe-o" + i).checked : f.optional
    };
  });
}
function wireFieldsEditor(state, redraw) {
  Array.prototype.forEach.call(document.querySelectorAll("[data-del]"), function (b) {
    b.onclick = function () {
      state.fields = readFieldsEditor(state.fields);
      state.fields.splice(+b.getAttribute("data-del"), 1);
      redraw();
    };
  });
  if ($("fe-add")) $("fe-add").onclick = function () {
    state.fields = readFieldsEditor(state.fields).concat([{ key: "", label: "", hint: "", optional: false }]);
    redraw();
  };
  if ($("fe-clear")) $("fe-clear").onclick = function () { state.fields = []; redraw(); };
  if ($("fe-preset")) $("fe-preset").onclick = function () {
    var p = KF.presetFor(state.appId || "");
    if (p) state.fields = JSON.parse(JSON.stringify(p.fields));
    redraw();
  };
}

/* 既有 App 的欄位設定（⚠️ 不動 token：改完按「換一把金鑰」時再把舊字串拆進各格讓他確認） */
/* 公開模式：打開網址就能用，沒有登入畫面。⛔ 預設一律加密，公開要明確按下去。 */
function appPublicSheet(a) {
  var on = !!a.public;
  var why = KF.publicBlockReason(a);
  openSheet("「" + a.name + "」要公開嗎？",
    '<p class="note bad">' + esc(KF.PUBLIC_WARNING).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>") + '</p>' +
    '<p class="note">公開之後：任何人打開那個 App 的網址就能用，<b>不需要選人、不需要密碼</b>。<br>' +
      '適合 TMDB／OMDb 這種免費查詢金鑰；GitHub token、密碼、有寫入權的東西絕對不行。</p>' +
    (why ? '<p class="note bad">' + esc(why) + '</p>' : '') +
    '<div class="menu-list">' +
      (on ? '<button class="danger" id="p-off">關掉公開，改回要密碼</button>'
          : '<button id="p-on">我知道會被看到，設成公開</button>') +
    '</div>',
    function () {
      if ($("p-on")) $("p-on").onclick = function () {
        var w = KF.publicBlockReason(a);
        if (w) return toast(w, true);
        runSave(null, "把 " + a.name + " 設成公開", function () { a.public = true; });
      };
      if ($("p-off")) $("p-off").onclick = function () {
        runSave(null, "把 " + a.name + " 改回加密", function () { a.public = false; });
      };
    });
}

/* ------------------------------------------------------------------ */
/* 開場外觀（App 啟動時中央那一塊：符號／名字／標語／三個顏色）             */
/* 純顯示、公開明文，跟金鑰與加密完全無關 —— 跟「公開模式」同一層級。       */
/* 全部可留白，留白＝那一項由 App 自己決定，**不會寫進 keyring.json**。      */
/* ------------------------------------------------------------------ */
var SP_LABELS = { bg: "開場底色", accent: "符號底色", ink: "開場文字色" };

/* 列表上那一行摘要：一眼看得出這個 App 已經設過開場 */
function splashSummary(sp) {
  var bits = [];
  if (sp.glyph) bits.push("符號 " + sp.glyph);
  if (sp.name) bits.push("名字 " + sp.name);
  if (sp.tagline) bits.push("「" + sp.tagline + "」");
  var cols = (sp.bg ? 1 : 0) + (sp.accent ? 1 : 0) + (sp.ink ? 1 : 0);
  if (cols) bits.push("自訂 " + cols + " 個顏色");
  return bits.join(" · ");
}

function appSplashSheet(a) {
  var cur = KF.normSplash(a.splash) || {};
  var st = {
    name: cur.name || "", glyph: cur.glyph || "", tagline: cur.tagline || "",
    bg: cur.bg || "", accent: cur.accent || "", ink: cur.ink || ""
  };
  function colorRow(k) {
    var v = st[k], d = KF.SPLASH_DEFAULTS[k];
    return '<div class="sp-crow' + (v ? " on" : "") + '" id="sp-row-' + k + '">' +
      '<input type="color" id="sp-' + k + '" value="' + esc(v || d) + '" aria-label="' + esc(SP_LABELS[k]) + '">' +
      '<div class="sp-cinfo"><b>' + esc(SP_LABELS[k]) + '</b>' +
        '<span id="sp-txt-' + k + '">' + (v ? esc(v) : "沿用 App 預設") + '</span></div>' +
      '<button type="button" class="sp-clr" id="sp-clr-' + k + '"' + (v ? "" : " hidden") + '>改回預設</button>' +
      '</div>';
  }
  /* 縮圖：沒設定的項目用 KF.splashView 的預覽預設值畫（那些值不會被存進去）。
   * 手機上它是 sticky 的 —— 打字時鍵盤會把版面推上去，縮圖跟著留在畫面上才看得到效果。 */
  function paint() {
    var v = KF.splashView({ name: a.name, splash: st });
    var prev = $("sp-prev");
    if (!prev) return;
    prev.style.background = v.bg;
    /* 連 color 一起設：「預覽」那個角標用 currentColor，底色一深它就看不見了 */
    prev.style.color = v.ink;
    $("sp-mark").style.background = v.accent;
    /* 符號字色不是設定項：由 accent 自動推導（PM 拍板，跟 app-template 共用同一個函式） */
    $("sp-mark").style.color = KF.onColor(v.accent);
    $("sp-mark").textContent = v.glyph;
    $("sp-nm").style.color = v.ink;
    $("sp-nm").textContent = v.name;
    $("sp-tg").style.color = v.ink;
    $("sp-tg").textContent = v.tagline;
    $("sp-tg").style.visibility = v.tagline ? "visible" : "hidden";
  }
  function wireColor(k) {
    var inp = $("sp-" + k);
    if (inp) inp.oninput = function () {
      st[k] = KF.normColor(inp.value);
      $("sp-row-" + k).className = "sp-crow on";
      $("sp-txt-" + k).textContent = st[k] || "沿用 App 預設";
      $("sp-clr-" + k).hidden = false;
      paint();
    };
    var clr = $("sp-clr-" + k);
    if (clr) clr.onclick = function () {
      st[k] = "";
      $("sp-" + k).value = KF.SPLASH_DEFAULTS[k];
      $("sp-row-" + k).className = "sp-crow";
      $("sp-txt-" + k).textContent = "沿用 App 預設";
      clr.hidden = true;
      paint();
    };
  }
  function draw() {
    openSheet("「" + a.name + "」的開場畫面",
      '<div class="sp-prev" id="sp-prev">' +
        '<div class="sp-mark" id="sp-mark"></div>' +
        '<div class="sp-nm" id="sp-nm"></div><div class="sp-tg" id="sp-tg"></div></div>' +
      '<div class="sp-tip">↑ 即時預覽：改下面任何一項，上面就會跟著變</div>' +
      '<p class="note">那個 App 一打開看到的第一頁。存檔＝發布，那個 App <b>下次啟動</b>就會變。<br>' +
        '每一項都可以留白，留白的項目由 App 自己決定（<b>不會寫進公開檔</b>）。</p>' +
      '<label class="field"><span class="fl">開場顯示的名字</span>' +
        '<input id="sp-name" type="text" maxlength="' + KF.SPLASH_MAX.name + '" value="' + esc(st.name) +
        '" placeholder="留白＝用「' + esc(a.name) + '」"></label>' +
      '<label class="field"><span class="fl">符號（只能一個字）</span>' +
        '<input id="sp-glyph" type="text" value="' + esc(st.glyph) + '" autocomplete="off" ' +
        'placeholder="留白＝用名字的第一個字">' +
        '<span class="hint">一個字或一個符號都可以（中文字、英文字母、emoji）。打第二個字不會吃進去。</span></label>' +
      colorRow("bg") + colorRow("accent") + colorRow("ink") +
      '<label class="field"><span class="fl">標語（選填）</span>' +
        '<input id="sp-tag" type="text" maxlength="' + KF.SPLASH_MAX.tagline + '" value="' + esc(st.tagline) +
        '" placeholder="例：紀律比行情重要"></label>' +
      '<div class="fr-acts"><button type="button" id="sp-reset">全部改回 App 預設</button></div>' +
      actsHtml("存起來"),
      function () {
        $("sp-name").oninput = function () { st.name = this.value; paint(); };
        $("sp-tag").oninput = function () { st.tagline = this.value; paint(); };
        /* 符號只能一個字：**在輸入框當場擋**。
         * ⚠️ 注音／拼音組字中不能動 value（會把他打到一半的字打斷）→ isComposing 時只畫預覽。 */
        $("sp-glyph").oninput = function (e) {
          var one = KF.normGlyph(this.value);
          if (!(e && e.isComposing) && this.value !== one) this.value = one;
          st.glyph = one;
          paint();
        };
        $("sp-glyph").onblur = function () {
          var one = KF.normGlyph(this.value);
          if (this.value !== one) this.value = one;
          st.glyph = one;
          paint();
        };
        wireColor("bg"); wireColor("accent"); wireColor("ink");
        $("sp-reset").onclick = function () {
          st = { name: "", glyph: "", tagline: "", bg: "", accent: "", ink: "" };
          draw();
        };
        wireActs(function (btn) {
          var out = KF.normSplash(st);          /* 空的項目在這裡就被丟掉，不會存進去 */
          var why = KF.splashBlockReason(out);
          if (why) return toast(why, true);
          runSave(btn, "改了 " + a.name + " 的開場外觀", function () {
            if (out) a.splash = out; else delete a.splash;
          });
        });
      });
    paint();
  }
  draw();
}

function appFieldsSheet(a) {
  var st = { appId: a.id, fields: KF.normFields(a.fields) };
  function draw() {
    openSheet("「" + a.name + "」的金鑰欄位",
      fieldsEditorHtml(st.fields, st.appId) +
      '<p class="note">存下去的時候，原本那串會<b>自動拆進各格</b>（拆不開的話一個字都不會動，' +
      '會標成「格式待確認」，等你自己填新的）。你貼過的東西不會不見。</p>' +
      actsHtml("存起來"),
      function () {
        wireFieldsEditor(st, draw);
        wireActs(function (btn) {
          var raw = readFieldsEditor(st.fields);
          var fields = KF.normFields(raw);
          if (raw.length && !fields.length) return toast("那幾格的代號還沒填（只能用英文小寫，例如 tmdb）", true);
          runSave(btn, "改了 " + a.name + " 的金鑰欄位", function () {
            a.fields = fields;
            /* 原地遷移：拆得開就正規化存回去；**拆不開就一個位元組都不動**（跟 server.js 同一條規則） */
            if (fields.length && a.token) {
              var r = KF.parse(fields, a.token);
              if (r.ok) a.token = KF.compose(fields, r.values, r.extra);
            }
          });
        });
      });
  }
  draw();
}

function appSheet(a) {
  var f = { emoji: a ? a.emoji : "📦", fields: a ? KF.normFields(a.fields) : [], appId: a ? a.id : "",
    /* 登記時先問「要不要金鑰」：只放連結的 App 不產密文、不出現在解鎖名單裡。
     * 不另外存一個 linkOnly 旗標 —— keyed 從 token 是不是空的推導就好（少一個會分岔的真相來源）。 */
    kind: a ? (a.token ? "key" : "link") : "link" };
  var donor = null;
  for (var i = ST.P.apps.length - 1; i >= 0; i--) if (ST.P.apps[i].token) { donor = ST.P.apps[i]; break; }
  function redraw() { f.appId = $("f-id") ? $("f-id").value.trim() : f.appId; appSheetDraw(a, f, donor); }
  appSheetDraw(a, f, donor);
}
function appSheetDraw(a, f, donor) {
  openSheet(a ? "改「" + a.name + "」" : "登記一個 App",
    '<label class="field"><span class="fl">名字</span>' +
      '<input id="f-name" type="text" value="' + esc(a ? a.name : "") + '" placeholder="旅途手帳"></label>' +
    (a ? '<div class="field"><span class="fl">代號</span><div class="keyline">' + esc(a.id) + '</div>' +
         '<span class="hint">代號登記好就不能改（App 前端是照它去找金鑰的）。</span></div>'
       : '<label class="field"><span class="fl">代號</span>' +
         '<input id="f-id" type="text" inputmode="latin" autocapitalize="off" placeholder="travel-book">' +
         '<span class="hint">要跟那個 App 前端 <code>Keyring.init({appId:…})</code> 寫的一模一樣，只能用英數與 - _ 。</span></label>') +
    (a ? "" :
      '<div class="kind" id="f-kind">' +
        '<button type="button" data-k="link" class="' + (f.kind === "link" ? "on" : "") + '">' +
          '<span class="ke">🔗</span><span><b>只放連結</b>' +
          '<span>只是想在啟動頁按一下就開它。不會出現在解鎖名單裡。</span></span></button>' +
        '<button type="button" data-k="key" class="' + (f.kind === "key" ? "on" : "") + '">' +
          '<span class="ke">🔑</span><span><b>連結＋金鑰</b>' +
          '<span>這個 App 要存東西回 GitHub。登記完再貼金鑰也可以。</span></span></button>' +
      '</div>') +
    '<label class="field"><span class="fl">網址（' + (a ? "選填" : "啟動頁的磚塊就是靠它開 App") + '）</span>' +
      '<input id="f-url" type="url" inputmode="url" value="' + esc(a ? (a.url || "") : "") + '" placeholder="https://xd1104.github.io/…"></label>' +
    '<label class="field"><span class="fl">GitHub repo（選填）</span>' +
      '<input id="f-repo" type="text" inputmode="latin" autocapitalize="off" spellcheck="false" value="' +
      esc(a ? (KF.normRepo(a.repo) || "") : "") + '" placeholder="xd1104/travel-book">' +
      '<span class="hint">拿來顯示「上次更新時間」。留空就從網址猜（猜不到就顯示「—」，不會亂猜）。</span></label>' +
    '<div class="field"><span class="fl">圖示</span>' + picksHtml("f-emoji", APP_EMOJIS, f.emoji) + '</div>' +
    (a ? "" : fieldsEditorHtml(f.fields, f.appId)) +
    (a || f.fields.length || f.kind === "link" ? "" :
      '<label class="field"><span class="fl">金鑰（選填）</span>' +
      '<textarea id="f-token" autocapitalize="off" autocomplete="off" placeholder="留空＝之後再填"></textarea>' +
      /* ⛔ 這裡以前寫「留空就沿用○○○那一把」，而且真的會抄過來。那等於讓金鑰在
       * App 之間流動，違反鐵律：每個 App 一把 fine-grained PAT、只授權它自己那一個
       * repo。實際後果是新登記的 App 被塞了一把能寫別人 repo 的 GitHub PAT。
       * 電腦端已經拿掉，手機端這一份是**另一套實作**（直接寫 vault，不走 server），
       * 所以要各修一次——這就是同一個規則存在兩個地方的代價。 */
      '<span class="hint">fine-grained PAT，只授權那一個 repo 的 Contents。' +
      '刻意不從別的 App 沿用——每個 App 一把。留空的話登記完再填也可以。</span></label>') +
    actsHtml(),
    function () {
      wirePicks("f-emoji", function (v) { f.emoji = v; });
      if ($("f-kind")) {
        Array.prototype.forEach.call($("f-kind").querySelectorAll("button"), function (b) {
          b.onclick = function () {
            f.kind = b.getAttribute("data-k");
            f.appId = $("f-id") ? $("f-id").value.trim() : f.appId;
            appSheetDraw(a, f, donor);
          };
        });
      }
      if (!a) wireFieldsEditor(f, function () {
        f.emoji = f.emoji; appSheetDraw(a, f, donor);
      });
      wireActs(function (btn) {
        var name = $("f-name").value.trim();
        if (!name) return toast("先給它一個名字", true);
        var url = $("f-url").value.trim();
        var repo = $("f-repo") ? KF.normRepo($("f-repo").value) : "";
        if ($("f-repo") && $("f-repo").value.trim() && !repo) {
          return toast("GitHub repo 要寫成 xd1104/travel-book 這種樣子", true);
        }
        /* 名字／網址／repo 會原樣進**公開的** apps.json（啟動頁在讀），先擋一次 */
        var whyPub = KF.appsBlockReason([{ id: (a && a.id) || name, name: name, emoji: f.emoji, url: url, repo: repo }]);
        if (whyPub) return toast(whyPub, true);
        if (a) {
          return runSave(btn, "改了 " + name, function () {
            a.name = name; a.emoji = f.emoji; a.url = url;
            if (repo) a.repo = repo; else delete a.repo;
          });
        }
        var wanted = slugify($("f-id").value || name);
        if (wanted && appById(wanted)) {
          return toast("已經有一個代號叫「" + wanted + "」的 App 了", true);
        }
        var rawFields = f.fields.length ? readFieldsEditor(f.fields) : [];
        var fields = KF.normFields(rawFields);
        if (rawFields.length && !fields.length) return toast("那幾格的代號還沒填（只能用英文小寫，例如 tmdb）", true);
        /* 沒填就是「還沒有金鑰」——**不從別的 App 沿用**（見上面的說明），
         * 也不擋：分格的 App 正常流程本來就是登記完再一格一格填。 */
        var token = $("f-token") ? $("f-token").value.trim() : "";
        runSave(btn, "登記了 App「" + name + "」", function () {
          var id = uniqueId(wanted || newId("app"), ST.P.apps.map(function (x) { return x.id; }));
          var made = { id: id, name: name, emoji: f.emoji, url: url, token: token, fields: fields };
          if (repo) made.repo = repo;
          made.order = ST.P.apps.length;      /* 新的排在最後面，位置固定不會跳 */
          ST.P.apps.push(made);
          /* 新 App 直接給所有現有成員，要收再到「誰可以用」取消。
           * ⚠️ 只放連結的 App 例外：它沒有金鑰可以解，掛在成員底下只是雜訊。 */
          if (f.kind === "key" || token || fields.length) {
            ST.P.users.forEach(function (u) {
              if (!Array.isArray(u.apps)) u.apps = [];
              if (u.apps.indexOf(id) < 0) u.apps.push(id);
            });
          }
        });
      });
    });
}

/* 金鑰到期日：自動測為主、手動填為輔 */
function appKeySheet(a) {
  var st = KF.keyExpState(a.keyExp, nowIso());
  var repo = KF.normRepo(a.repo) || KF.repoFromUrl(a.url || "");
  var box = "";
  if (st.state === "expired") {
    box = '<div class="expbox"><b>這把已經過期了</b>它現在存不了東西，而且不會跳錯誤——' +
      'App 看起來一切正常，資料就是沒進去。</div>';
  } else if (st.state === "soon") {
    box = '<div class="expbox"><b>還有 ' + st.days + ' 天</b>到期日是 GitHub 自己回報的，不是我填的。</div>';
  }
  openSheet("「" + a.name + "」的金鑰到期日",
    box +
    '<p class="note">現在：<b>' + esc(KF.keyLabel(st)) + '</b>' +
      (st.expiresAt ? '（' + esc(st.expiresAt) + '，' + (st.source === "manual" ? "自己填的" : "GitHub 回報的") + '）' : '') +
      (st.checkedAt ? '<br>上次檢查 ' + esc(fmtTime(st.checkedAt)) : '<br>還沒檢查過') +
      '<br>檢查是拿<b>這個 App 自己那把金鑰</b>去問 ' + esc(repo ? repo : "GitHub") + '，不會用到別的 App 的。</p>' +
    '<label class="field"><span class="fl">自己填一個日期（選填，備援用）</span>' +
      '<input id="f-exp" type="text" inputmode="numeric" placeholder="2026-12-02" value="' +
      esc(st.source === "manual" && st.expiresAt ? st.expiresAt : "") + '">' +
      '<span class="hint">自動測得到的時候會蓋掉它 —— 自動比人記得準。留空＝清掉。</span></label>' +
    '<div class="sheet-acts"><button class="cancel" id="sh-cancel">算了</button>' +
      '<button class="go" id="sh-check">重新檢查</button></div>' +
    '<button class="loadmore" id="sh-manual">存我填的日期</button>',
    function () {
      $("sh-cancel").onclick = closeSheet;
      $("sh-check").onclick = function () {
        var btn = $("sh-check");
        btn.disabled = true; btn.textContent = "問 GitHub…";
        checkAppKey(a).then(function (r) {
          closeSheet();
          toast(r.message);
          if (r.changed) save("重新檢查了「" + a.name + "」的金鑰到期日").catch(function (e) { toast(String(e.message || e), true); });
          else render();
        });
      };
      $("sh-manual").onclick = function () {
        var v = ($("f-exp").value || "").trim();
        if (v && !KF.normDate(v)) return toast("日期要寫成 2026-12-02 這種樣子", true);
        runSave($("sh-manual"), v ? ("把「" + a.name + "」的到期日填成 " + v) : ("清掉「" + a.name + "」的到期日"), function () {
          if (v) a.keyExp = { expiresAt: v, source: "manual", checkedAt: nowIso(), state: "ok" };
          else delete a.keyExp;
        });
      };
    });
}

/* 啟動頁磚塊的位置。**固定順序**是 Benson 拍板的：不做「最近更新排前面」，
 * 位置每天跳的話肌肉記憶就沒了。 */
function appOrderSheet(a) {
  var list = appsInOrder();
  var i = list.indexOf(a);
  function move(dir, btn) {
    var j = i + dir;
    if (j < 0 || j >= list.length) return;
    runSave(btn, "把「" + a.name + "」在啟動頁的位置" + (dir < 0 ? "往前挪" : "往後挪"), function () {
      var arr = list.slice(), t = arr[i];
      arr[i] = arr[j]; arr[j] = t;
      arr.forEach(function (x, k) { x.order = k; });
    });
  }
  openSheet("「" + a.name + "」在啟動頁的位置",
    '<p class="note">現在排第 ' + (i + 1) + ' 個（共 ' + list.length + ' 個）。順序是固定的，不會自己跳來跳去。</p>' +
    '<ul class="rc-log"><li></li></ul>'.replace("<li></li>", list.map(function (x, k) {
      return '<li><i>' + (k + 1) + '.</i>' + esc(x.emoji + " " + x.name) + (x === a ? "　←" : "") + '</li>';
    }).join("")) +
    '<div class="sheet-acts"><button class="cancel" id="sh-up">↑ 往前</button>' +
      '<button class="go" id="sh-down">↓ 往後</button></div>',
    function () {
      $("sh-up").onclick = function () { move(-1, $("sh-up")); };
      $("sh-down").onclick = function () { move(1, $("sh-down")); };
    });
}

function appTokenSheet(a) {
  var fs = KF.normFields(a.fields);
  if (fs.length) return appTokenSheetMulti(a, fs);
  var repo = KF.normRepo(a.repo) || KF.repoFromUrl(a.url || "");
  openSheet("換「" + a.name + "」的金鑰",
    '<p class="note">貼新的進去，所有人的密文都會用新金鑰重產一次。' +
      '他們不用重新解鎖 —— 裝置記著的是派生金鑰，下次開 App 會自動換過去。</p>' +
    (repo ? '<ol class="steps"><li>GitHub → Settings → Developer settings → Fine-grained tokens</li>' +
      '<li>只勾 <b>' + esc(repo) + '</b> 這一個 repo，權限 Contents: Read and write</li>' +
      '<li>把產生的那一串貼進來</li></ol>' : '') +
    '<label class="field"><span class="fl">新的 GitHub 金鑰</span>' +
      '<textarea id="f-token" autocapitalize="off" autocomplete="off" placeholder="github_pat_…"></textarea>' +
      '<span class="hint">現在是 ' + esc(a.token ? maskToken(a.token) : "沒有金鑰") + '</span></label>' +
    '<p class="note">存下去之前會先去問 GitHub 這把什麼時候到期，不用自己填。' +
      '問不到（例如是不會過期的舊式金鑰）會照實說「不會過期」，不會裝作沒事。</p>' +
    actsHtml("換掉"),
    function () {
      wireActs(function (btn) {
        var token = $("f-token").value.trim();
        if (!token) return toast("先貼上新的金鑰", true);
        /* 先用**新的那把**去問一次到期日（規格：存了新金鑰的當下必測）。
         * probe 是一個臨時物件，明文不會多存到任何地方。 */
        btn.disabled = true; btn.textContent = "問一下 GitHub…";
        var probe = { id: a.id, token: token, url: a.url, repo: a.repo, keyExp: null };
        checkAppKey(probe).then(function (r) {
          btn.disabled = false;
          runSave(btn, "換了 " + a.name + " 的金鑰", function () {
            a.token = token;
            if (probe.keyExp) a.keyExp = probe.keyExp; else delete a.keyExp;
          });
          if (r.message) toast(r.message);
        });
      });
    });
}

/* 多欄位版。⚠️ 跟本機後台同一個姿態：**畫面上只有遮罩，留空＝不改這一格**。
 * 手機這邊雖然自己解得開真本（明文本來就在這台裝置的記憶體裡），但畫面不預填、不顯示明文——
 * 兩個後台的行為要一致，而且被人瞄到螢幕的成本太高。 */
function appTokenSheetMulti(a, fs) {
  var mk = KF.maskedFields(fs, a.token);
  var ok = KF.parse(fs, a.token).ok;
  openSheet("「" + a.name + "」的金鑰",
    (ok ? "" : '<p class="note bad">這個 App 存的還是舊格式（一整串）。上面第一格顯示的就是那一串，' +
      '把它換成正確的值再存一次就好 —— 在你按存起來之前，原本的東西一個字都不會動。</p>') +
    fs.map(function (f, i) {
      var m = mk[i] || {};
      return '<label class="field"><span class="fl">' + esc(f.label) + (f.optional ? "（可留空）" : "") + '</span>' +
        '<textarea id="mf-' + i + '" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="' +
        (m.filled ? "留空就不動它" : "貼上金鑰") + '"></textarea>' +
        /* ⚠️ 說明**另起一行**，不要跟「目前 …」黏在同一行：黏在一起時它讀起來像
         *    第二個「目前的值」，同一格會出現兩個對不起來的現況（實際被回報過）。 */
        '<span class="hint">' + (m.filled ? "目前 " + esc(m.masked) + "，留空＝不改這一格" : "目前還沒填") + '</span>' +
        (f.hint ? '<span class="hint">' + esc(KF.safeHint(f.hint)) + '</span>' : "") +
        (m.filled && f.optional
          ? '<label class="fr-opt"><input type="checkbox" id="mc-' + i + '"> 清掉這一格</label>' : "") +
        '</label>';
    }).join("") +
    '<p class="note">存進去的還是同一串字（後台幫你組好），所以那個 App 不用改任何東西。' +
      '他們也不用重新解鎖。</p>' +
    actsHtml("存起來"),
    function () {
      wireActs(function (btn) {
        var typed = {}, clear = [], touched = false, bad = "";
        fs.forEach(function (f, i) {
          var v = $("mf-" + i) ? $("mf-" + i).value.trim() : "";
          var cl = $("mc-" + i) && $("mc-" + i).checked;
          if (v) { typed[f.key] = v; touched = true; }
          if (cl) { clear.push(f.key); touched = true; }
          if (!f.optional && !v && !(mk[i] && mk[i].filled)) bad = bad || ("「" + f.label + "」還沒填");
          if (!f.optional && cl) bad = bad || ("「" + f.label + "」是必填的，不能清掉");
        });
        if (bad) return toast(bad, true);
        if (!touched) return toast("沒有改到任何一格", true);
        var cur = KF.parse(fs, a.token);
        var next = KF.merge(fs, cur.values, typed, clear);
        var v2 = KF.validate(fs, next);
        if (!v2.ok) return toast(v2.message, true);
        runSave(btn, "換了 " + a.name + " 的金鑰", function () { a.token = KF.compose(fs, next, cur.extra); });
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
      '<button id="s-who">🙋 這台是誰在用　' + esc(ST.who || "還沒寫") + '</button>' +
      '<button id="s-pair">📱 這台裝置的配對碼</button>' +
      '<button id="s-lock">🔒 鎖起來</button>' +
    '</div>',
    function () {
      $("s-gh").onclick = askGithubToken;
      $("s-who").onclick = function () { whoSheet(true); };
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

/* 「這台是誰在用」——只為了近況那一頁的「誰改的」。
 * ⚠️ 手機端的 commit 是用鑰匙圈那把 PAT 走 GitHub API 送的，所以 git 的 author
 *    不管是黏還是肚都是 xd1104；名字拿不到，只能自己寫進 commit message。
 * ⚠️ 它**不是登入、不是權限**：只存在這台裝置的 localStorage，不進任何公開檔。
 *    不想寫也可以（trailer 就會是 `by: · 手機後台`，誠實留白，不編一個名字）。 */
function whoSheet(fromSettings) {
  var names = (ST.P.users || []).map(function (u) { return u.emoji + " " + u.name; });
  openSheet("這台是誰在用？",
    '<p class="note">只用在「近況」那一頁的「誰改的」。它只存在這支手機裡，' +
      '不會進鑰匙圈、也不會給別人看到。不想寫就按「先不要」。</p>' +
    (names.length ? '<div class="kind" id="f-who">' + (ST.P.users || []).map(function (u) {
      return '<button type="button" data-w="' + esc(u.name) + '" class="' + (ST.who === u.name ? "on" : "") + '">' +
        '<span class="ke">' + esc(u.emoji || "🧑") + '</span><span><b>' + esc(u.name) + '</b>' +
        '<span>之後的紀錄會寫「' + esc(u.name) + '（手機後台）」</span></span></button>';
    }).join("") + '</div>' : "") +
    '<label class="field"><span class="fl">或自己打一個</span>' +
      '<input id="f-who-txt" type="text" value="' + esc(ST.who || "") + '" placeholder="例：肚"></label>' +
    '<div class="sheet-acts"><button class="cancel" id="sh-cancel">先不要</button>' +
      '<button class="go" id="sh-go">就這樣</button></div>',
    function () {
      if ($("f-who")) {
        Array.prototype.forEach.call($("f-who").querySelectorAll("button"), function (b) {
          b.onclick = function () { $("f-who-txt").value = b.getAttribute("data-w"); };
        });
      }
      $("sh-cancel").onclick = function () {
        /* 按了「先不要」就記下來，不要每次解鎖都再問一次 */
        try { localStorage.setItem(NS + "whoAsked", "1"); } catch (e) {}
        closeSheet();
      };
      $("sh-go").onclick = function () {
        ST.who = ($("f-who-txt").value || "").trim().slice(0, 20);
        try {
          localStorage.setItem(NS + "who", ST.who);
          localStorage.setItem(NS + "whoAsked", "1");
        } catch (e) {}
        closeSheet();
        render();
        if (fromSettings) toast(ST.who ? ("好，之後記成「" + ST.who + "」") : "好，之後不寫名字");
      };
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
  try { ST.who = localStorage.getItem(NS + "who") || ""; } catch (e) { ST.who = ""; }
  /* 啟動頁的提醒帶會帶著 ?app=<id>&do=key 進來：解鎖之後直接把換金鑰那張 sheet 端出來
   * （擋下來不等於告訴他該去哪）。 */
  var q = /[?&]app=([^&]+)/.exec(location.search || "");
  var act = /[?&]do=([a-z]+)/.exec(location.search || "");
  if (q) ST.deepLink = { app: decodeURIComponent(q[1]), do: act ? act[1] : "key" };
  /* 帶配對碼的連結：#pair=XXXX-XXXX-XXXX-XXXX。收下就把它從網址列擦掉，不要留在歷史紀錄裡 */
  var m = /[#&]pair=([0-9A-Za-z-]+)/.exec(location.hash || "");
  if (m) {
    ST.pairing = normalizePairing(m[1]);
    try { localStorage.setItem(NS + "pairing", ST.pairing); } catch (e) {}
    history.replaceState(null, "", location.pathname + location.search);
  }
  renderLock();
})();
