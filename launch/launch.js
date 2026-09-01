"use strict";
/*
 * 鑰匙圈 · 啟動頁（2026-08-28）
 * ------------------------------------------------------------------
 * 一頁把我的 App 全部列出來，點一下就開。**免密碼**：它只讀公開的 apps.json，
 * 那份檔案裡一個祕密都沒有（產生器是 client/keyring-fields.js 的 buildApps()，白名單）。
 *
 * 三個刻意的決定：
 *   1. 磚塊**不分**「有金鑰／只有連結」——要開 App 的時候他不在乎那件事。
 *   2. 順序**固定**（apps.json 的 order，後台可上移下移），不照最近更新排序：
 *      位置每天跳，肌肉記憶就沒了。
 *   3. 磚塊是真的 <a target="_blank">，不是 JS 導頁：長按可以「在新分頁開」、離線也點得開。
 *
 * 「有沒有資料」與「畫不畫得出來」是解耦的：
 *   apps.json 走 cache-first（localStorage 那份先畫，再背景抓新的）；
 *   更新時間抓不到就顯示「—」，**不擋畫面、不跳錯誤**，footer 誠實說這次沒拿到。
 */
(function () {
  var KF = window.KeyringFields;
  var NS = "keyring.launch.";
  var K_APPS = NS + "apps";      /* 上次抓到的 apps.json（離線就靠它） */
  var K_PUSH = NS + "pushed";    /* repo -> pushed_at 的快取（未認證的 GitHub API 一小時只有 60 次） */
  var K_A2HS = NS + "a2hs";      /* 「加到主畫面」那條關掉了沒 */
  var PUSH_TTL = 30 * 60 * 1000;

  var S = {
    doc: null,          /* apps.json */
    from: "",           /* cache | net */
    pushed: {},         /* repo -> ISO */
    pushedAt: 0,        /* 那份資料是什麼時候拿到的 */
    statFail: "",       /* 更新時間為什麼沒拿到 */
    offline: false,
    loading: true
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無痕模式：不快取就是了 */ } }
  function toast(m) {
    var t = $("toast");
    t.textContent = m; t.className = "";
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = "hidden"; }, 2000);
  }
  function clock(ms) {
    var d = new Date(ms);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  /* 「更新於 X」用的相對時間。⚠️ 這是 repo 最後被 push 的時間，
   *    跟 Pages 有沒有部署成功無關 —— 所以文案是「更新於」，不是「已上線」。 */
  function ago(iso) {
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
  function stateOf(a) {
    if (!a || !a.keyed) return { state: "nokey", days: null };
    return KF.keyExpState(a.key, new Date().toISOString());
  }
  /* GitHub 帳號：從 apps.json 的 repo 推（不寫死；用最多人用的那個 owner） */
  function ownerOf(apps) {
    var count = {}, best = "", n = 0, i, o;
    for (i = 0; i < apps.length; i++) {
      o = String(apps[i].repo || "").split("/")[0];
      if (!o) continue;
      count[o] = (count[o] || 0) + 1;
      if (count[o] > n) { n = count[o]; best = o; }
    }
    return best;
  }

  /* ---------------- 畫面 ---------------- */
  function render() {
    var b = $("lc-body");
    var apps = (S.doc && S.doc.apps) || [];

    if (!S.doc && S.loading) {
      var sk = "";
      for (var i = 0; i < 6; i++) {
        sk += '<div class="tile sk"><div class="em"></div><div class="nm"></div><div class="sub"></div></div>';
      }
      b.innerHTML = '<div class="tiles">' + sk + '</div><p class="lc-foot">正在拿清單…</p>';
      return;
    }
    if (!S.doc) {
      b.innerHTML = '<div class="emptybox"><div class="big">🌧️</div>'
        + '<p>現在拿不到清單，這台裝置也還沒存過一份。<br>可能是網路的關係。</p>'
        + '<button class="go" id="lc-retry">↻ 再試一次</button></div>';
      $("lc-retry").onclick = function () { boot(true); };
      return;
    }
    if (!apps.length) {
      b.innerHTML = '<div class="emptybox"><div class="big">📭</div>'
        + '<p>還沒有登記任何 App。<br>到管理頁登記一個，這裡就會出現。</p>'
        + '<a class="go" href="web/">🔑 去登記</a></div>';
      return;
    }

    var h = "";
    if (S.offline) {
      h += '<div class="offline"><span>📴</span><div>現在連不上網路。這是上次看到的清單，'
        + '<b>照樣點得開</b>；更新時間先不顯示。</div></div>';
    }

    /* 提醒帶：已過期（紅）優先，其次 ≤14 天（琥珀）。沒事就整條不存在。 */
    var bad = [], soon = [], unknown = 0, keyed = 0, k;
    apps.forEach(function (a) {
      if (!a.keyed) return;
      keyed++;
      k = stateOf(a);
      if (k.state === "expired") bad.push(a);
      else if (k.state === "soon" && k.days <= KF.KEY_ALERT_DAYS) soon.push(a);
      else if (k.state === "unknown") unknown++;
    });
    if (bad.length) {
      h += '<div class="alert bad"><span class="ai">🔴</span><div class="ab">'
        + '<b>' + esc(bad[0].name) + ' 的金鑰已經過期</b>'
        + '<span>它現在存不了東西，而且不會跳錯誤。換一把新的就好。'
        + (bad.length > 1 ? '（另外還有 ' + (bad.length - 1) + ' 個）' : '') + '</span></div>'
        + '<a class="ago" href="' + fixUrl(bad[0].id) + '">去換</a></div>';
    } else if (soon.length) {
      k = stateOf(soon[0]);
      h += '<div class="alert"><span class="ai">🟠</span><div class="ab">'
        + '<b>' + esc(soon[0].name) + ' 的金鑰還有 ' + k.days + ' 天</b>'
        + '<span>過期那天它會安靜地存不了東西，先換掉比較省事。</span></div>'
        + '<a class="ago" href="' + fixUrl(soon[0].id) + '">去換</a></div>';
    }

    h += '<div class="tiles">';
    apps.forEach(function (a) {
      var st = stateOf(a), dot = "";
      if (st.state === "expired") dot = '<span class="dot bad"></span>';
      else if (st.state === "soon" && st.days <= KF.KEY_ALERT_DAYS) dot = '<span class="dot"></span>';
      var sub = S.offline ? "" : (S.statFail ? "—" : (a.repo ? ago(S.pushed[a.repo]) : "—"));
      var body = dot
        + '<span class="em">' + esc(a.emoji || "📦") + '</span>'
        + '<span class="nm">' + esc(a.name || a.id) + '</span>'
        + '<span class="sub">' + esc(a.url ? sub : "還沒填網址") + '</span>';
      h += a.url
        ? '<a class="tile" href="' + esc(a.url) + '" target="_blank" rel="noopener">' + body + '</a>'
        : '<div class="tile nourl">' + body + '</div>';
    });
    h += '</div>';

    var foot;
    if (S.offline) {
      foot = "離線中" + (S.pushedAt ? " · 資料截至 " + clock(S.pushedAt) : "");
    } else if (S.statFail) {
      foot = esc(S.statFail) + "<br>清單照常，等一下再看";
    } else {
      var line = "";
      if (!bad.length && !soon.length && keyed) {
        /* ⚠️ 有「還沒檢查過」的就不准講「都還有效」——那正是「測不到被畫成沒事」 */
        line = unknown
          ? "🔑 " + keyed + " 把金鑰，其中 " + unknown + " 把還沒檢查過<br>"
          : "🔑 " + keyed + " 把金鑰都還有效<br>";
      }
      foot = line + "資料截至 " + clock(S.pushedAt || Date.now());
    }
    h += '<p class="lc-foot">' + foot + ' · <button id="lc-reload">重新整理</button></p>';

    if (load(K_A2HS) !== 0 && !S.offline) {
      h += '<div class="a2hs"><p>把這一頁加到主畫面，以後一按就開，不用密碼。</p>'
        + '<button id="lc-a2hs" aria-label="不用了">✕</button></div>';
    }
    b.innerHTML = h;
    if ($("lc-reload")) $("lc-reload").onclick = function () { boot(true); };
    if ($("lc-a2hs")) $("lc-a2hs").onclick = function () { save(K_A2HS, 0); render(); };
  }
  /* 提醒帶點下去＝直接把手機後台的「換金鑰」那張 sheet 端出來
     （沿用 v3 那條教訓：擋下來不等於告訴他該去哪）。 */
  function fixUrl(id) { return "web/?app=" + encodeURIComponent(id) + "&do=key"; }

  /* ---------------- 抓資料 ---------------- */
  function fetchApps() {
    return fetch("apps.json?t=" + Date.now(), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (doc) {
      if (!doc || !Array.isArray(doc.apps)) throw new Error("apps.json 格式看不懂");
      S.doc = doc; S.from = "net"; S.offline = false;
      save(K_APPS, doc);
      return doc;
    });
  }
  /* 一個未認證的請求就拿得到全部 repo 的 pushed_at（60 次/小時/IP，所以快取 30 分鐘） */
  function fetchPushed(force) {
    var cache = load(K_PUSH);
    if (!force && cache && cache.at && (Date.now() - cache.at) < PUSH_TTL) {
      S.pushed = cache.map || {}; S.pushedAt = cache.at; S.statFail = "";
      return Promise.resolve();
    }
    var owner = ownerOf((S.doc && S.doc.apps) || []);
    if (!owner) { S.statFail = ""; return Promise.resolve(); }
    return fetch("https://api.github.com/users/" + encodeURIComponent(owner) + "/repos?sort=pushed&per_page=100", {
      headers: { "Accept": "application/vnd.github+json" }
    }).then(function (r) {
      if (r.status === 403 || r.status === 429) throw new Error("rate");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (list) {
      var map = {};
      (list || []).forEach(function (x) { if (x && x.full_name) map[x.full_name] = x.pushed_at; });
      S.pushed = map; S.pushedAt = Date.now(); S.statFail = "";
      save(K_PUSH, { at: S.pushedAt, map: map });
    }, function (e) {
      /* 拿不到更新時間**不是錯誤畫面**：清單照常，只是那一行顯示「—」 */
      if (cache) { S.pushed = cache.map || {}; S.pushedAt = cache.at; }
      S.statFail = String(e && e.message) === "rate"
        ? "更新時間這次沒拿到（GitHub 問太多次了）"
        : "更新時間這次沒拿到";
    });
  }

  function boot(manual) {
    var cached = load(K_APPS);
    if (cached && !S.doc) { S.doc = cached; S.from = "cache"; }
    S.loading = true;
    render();
    fetchApps().then(function () {
      S.loading = false;
      render();                       /* 清單先畫出來，更新時間晚一點到 */
      return fetchPushed(!!manual);
    }, function () {
      /* 抓不到就用快取那份撐著：離線時磚塊照樣全部點得開 */
      S.loading = false;
      S.offline = !!S.doc;
      /* 上次拿到更新時間是什麼時候，離線時照實說（不要假裝是現在） */
      var pc = load(K_PUSH);
      if (pc && pc.at) { S.pushed = pc.map || {}; S.pushedAt = pc.at; }
      render();
      if (manual) toast(S.doc ? "還是連不上，先用上次的清單" : "現在拿不到清單");
      return null;
    }).then(function () {
      S.loading = false;
      render();
      if (manual) toast("已更新");
    });
  }

  window.addEventListener("online", function () { S.offline = false; boot(false); });
  window.addEventListener("offline", function () { S.offline = true; render(); });
  boot(false);

  /* 讓「加到主畫面」之後在飛航模式打開也還是這一頁，而不是一片白。
   * sw.js 只快取啟動頁那四個檔案，其他請求（含手機後台）完全不插手。 */
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* 註冊不了就算了，只是離線不保證 */ });
    });
  }
})();
