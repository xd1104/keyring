/* 鑰匙圈 — 多欄位金鑰的共用邏輯（零依賴，Node 與瀏覽器共用一份）
 * ------------------------------------------------------------------
 * 為什麼有這支：
 *   鑰匙圈的儲存格式是「一個 App ＝ 一串不透明字串」，加密進 keyring.json。
 *   但有些 App 需要不只一把金鑰（好雷嗎要 TMDB ＋ OMDb），
 *   以前的做法是叫 Benson 自己手打 {"tmdb":"…","omdb":"…"} 一整行 —— 他嫌蠢，沒錯，是很蠢。
 *
 * 這支做的事只有一件：**後台 UI 的「幾格輸入框」 ←→ 「那一串字串」的互轉**。
 *   ⭐ 儲存格式完全沒有變：加密的還是同一串字。
 *   ⭐ 所以 keyring.json 的結構、client/keyring-unlock.js 的解密流程**都不用動**，
 *      三個 App 的前端也不用動（好雷嗎本來就自己會把那串 JSON 拆成兩把）。
 *
 * 沒有宣告 fields 的 App（旅途手帳、食譜本）**行為與畫面完全不變**，這是硬需求：
 *   normFields() 對 undefined／null／壞資料一律回 []，isMulti() 就是 false，
 *   後台走的還是原本那條「一格」的路。
 *
 * 三個地方共用這一份（server.js、public/admin.js、web/admin.js）——
 * 加解密參數那種「三邊各一份」的痛，這裡不要再來一次。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.KeyringFields = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var MAX_FIELDS = 6;          /* 後台 UI 不給無限加，超過就不是「幾把金鑰」而是資料庫了 */
  var KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;   /* 欄位代號：ASCII 小寫（跟 App id 的鐵律同一個理由） */

  function str(v) { return String(v == null ? "" : v); }
  function trim(v) { return str(v).trim(); }

  /* ------------------------------------------------------------------
   * 「說明」不是放金鑰的地方（2026-08-24 實際踩到）
   * ------------------------------------------------------------------
   * 宣告欄位的表單只有「代號／標題／說明」三格、**沒有值的格子**（值是之後在
   * 「換金鑰」那個對話框填的）。那張表單看起來就像在填金鑰，所以說明框
   * 成了最順手的地方 —— 實際發生過：一把 32 碼的 TMDB 與一把 8 碼的 OMDb
   * 金鑰被貼進 hint，而 hint 是**設計來顯示在畫面上**的文字，後台就忠實照印，
   * 於是同一格上面寫「目前 gith••••••••pY」（遮罩）、下面卻是一串明文。
   *
   * 這裡只做兩件事，刻意**不動已經存進去的資料**：
   *   1. 顯示端用 safeHint() 換成警告（使用者才知道要自己搬走，而不是被靜靜刪掉）
   *   2. 寫入端用 looksSecret() 擋下來，不讓同一件事再發生一次
   * 「靜靜清掉」是不可以的——那串很可能是他那把金鑰在這個系統裡的唯一副本。
   */

  /** 這串文字看起來像不像一把金鑰（保守判定，寧可漏抓也不要誤擋正常說明）。
   *  正常的說明幾乎一定含空白或中文（例：「API Key (v3 auth)，32 碼那組」）——
   *  那些都不會命中。命中的是「一整串不透明字元」： */
  function looksSecret(s) {
    var t = trim(s);
    if (!t) return false;
    if (/\s/.test(t)) return false;                 /* 有空白＝是句子不是金鑰 */
    if (/^[0-9a-f]{8,}$/i.test(t)) return true;     /* 純十六進位 ≥8：TMDB 32 碼、OMDb 8 碼都在這 */
    if (/^[A-Za-z0-9_\-.]{16,}$/.test(t)) return true; /* 夠長的不透明字串：PAT／base64 那類 */
    return false;
  }

  /** 顯示用的說明：像金鑰就不要印出來，改印一句叫他去搬走的話。 */
  function safeHint(s) {
    return looksSecret(s)
      ? "⚠ 這一格的說明看起來像一把金鑰，已隱藏。金鑰請填在上面的輸入框，並把說明清空。"
      : trim(s);
  }

  /** 把使用者填的欄位代號正規化成安全的 key；不合格回 "" */
  function normKey(k) {
    var s = trim(k).toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!s) return "";
    if (!/^[a-z]/.test(s)) s = "k" + s;
    return s.slice(0, 24);
  }

  /**
   * 正規化欄位宣告。**任何看不懂的東西都回 []（＝單欄位、行為不變）**，
   * 這條是舊 keyring.json／vault.json 的向後相容保證。
   */
  function normFields(fields) {
    if (!Array.isArray(fields)) return [];
    var out = [], seen = {};
    for (var i = 0; i < fields.length && out.length < MAX_FIELDS; i++) {
      var f = fields[i];
      if (!f || typeof f !== "object") continue;
      var key = normKey(f.key);
      if (!key || !KEY_RE.test(key) || seen[key]) continue;
      seen[key] = true;
      out.push({
        key: key,
        label: trim(f.label) || key,
        hint: trim(f.hint),
        optional: !!f.optional
      });
    }
    return out;
  }

  /** 這個 App 是不是多欄位（沒宣告＝不是，走原本那條路） */
  function isMulti(app) { return normFields(app && app.fields).length > 0; }

  /**
   * 幾格 → 一串。
   * 一律輸出**所有已宣告的欄位**（沒填的給空字串），順序照宣告順序：
   * 少一個 key 跟「填了空字串」在下游是兩種意思，固定輸出全部比較好預期。
   * extra 是解析時撿到、但不在宣告裡的鍵——原樣帶回去，不要靜靜弄丟他的資料。
   */
  function compose(fields, values, extra) {
    var fs = normFields(fields), obj = {}, i, k;
    if (extra && typeof extra === "object") {
      for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) obj[k] = str(extra[k]);
    }
    for (i = 0; i < fs.length; i++) obj[fs[i].key] = trim(values ? values[fs[i].key] : "");
    return JSON.stringify(obj);
  }

  /**
   * 一串 → 幾格。**絕對不會靜靜清空他的資料。**
   * 回傳 { values, extra, ok, raw, message }
   *   ok:false ＝ 那串字不是我們認得的 JSON 物件（例如他以前手打錯了，或裡面是一把裸金鑰）
   *               → 整串原樣放進**第一格**，讓他看得到、自己改，raw 留著原文。
   */
  function parse(fields, token) {
    var fs = normFields(fields), values = {}, extra = {}, i;
    for (i = 0; i < fs.length; i++) values[fs[i].key] = "";
    var raw = str(token);
    if (!raw.trim()) return { values: values, extra: extra, ok: true, raw: "", message: "" };

    var obj = null;
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      if (fs.length) values[fs[0].key] = raw.trim();
      return {
        values: values, extra: extra, ok: false, raw: raw,
        message: "這個 App 原本存的不是分格的格式，已經整串放進第一格了。確認一下再存檔。"
      };
    }
    var known = {};
    for (i = 0; i < fs.length; i++) {
      known[fs[i].key] = true;
      values[fs[i].key] = trim(obj[fs[i].key]);
    }
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k) || known[k]) continue;
      extra[k] = str(obj[k]);      /* 宣告以外的鍵：原樣留著，存檔時再帶回去 */
    }
    return { values: values, extra: extra, ok: true, raw: raw, message: "" };
  }

  /** 必填的有沒有填。回 { ok, message } */
  function validate(fields, values) {
    var fs = normFields(fields);
    for (var i = 0; i < fs.length; i++) {
      if (fs[i].optional) continue;
      if (!trim(values ? values[fs[i].key] : "")) {
        return { ok: false, message: "「" + fs[i].label + "」還沒填" };
      }
    }
    return { ok: true, message: "" };
  }

  /**
   * 單格金鑰的遮罩。**比 server.js 的 maskToken 更狠，這是刻意的**：
   * maskToken 是為 GitHub PAT 設計的（`github_pat_11AB…` 前面十幾個字是公開的前綴，
   * 露出來沒關係），但這裡放的是 **TMDB 32 碼、OMDb 8 碼**這種「整串都是祕密」的金鑰，
   * 露前 14 碼等於露掉一半。所以一律「最多前 4、後 2」，短的整條遮掉。
   * ⚠️ 後台任何畫面、任何 API 回應都只會出現這個函式的輸出，不會出現明文。
   */
  function maskField(v) {
    var t = trim(v);
    if (!t) return "";
    if (t.length <= 8) return "••••••••";
    if (t.length <= 14) return t.slice(0, 2) + "••••••••";
    return t.slice(0, 4) + "••••••••" + t.slice(-2);
  }

  /** 每一格的遮罩（給後台畫面用）：[{key,label,hint,optional,masked,filled}] */
  function maskedFields(fields, token) {
    var fs = normFields(fields), r = parse(fs, token), out = [];
    for (var i = 0; i < fs.length; i++) {
      var v = r.ok ? r.values[fs[i].key] : (i === 0 ? r.raw : "");
      out.push({
        key: fs[i].key, label: fs[i].label, hint: fs[i].hint, optional: fs[i].optional,
        masked: maskField(v), filled: !!trim(v)
      });
    }
    return out;
  }

  /** 列表上那行摘要：`tmdb ab•••••••• · omdb 沒填`
   *  單欄位（沒宣告 fields）走呼叫端原本的遮罩函式，行為與畫面完全不變。 */
  function maskSummary(fields, token, maskFn) {
    var fs = normFields(fields);
    if (!fs.length) return maskFn(str(token));
    var r = parse(fs, token), out = [];
    if (!r.ok) return "格式待確認：" + maskField(r.raw);
    for (var i = 0; i < fs.length; i++) {
      var v = r.values[fs[i].key];
      out.push(fs[i].key + " " + (v ? maskField(v) : "沒填"));
    }
    return out.join(" · ");
  }

  /**
   * 換金鑰時的合併：**只進不出**。
   * cur    ＝ 現在存的各格（server 自己拆出來的，明文一步都不離開 server）
   * typed  ＝ 他這次真的打了字的那幾格（沒打的不會出現）
   * clear  ＝ 他明確按了「清掉這格」的 key
   * 沒打字又沒按清掉的格子 → **原值留著**。
   */
  function merge(fields, cur, typed, clear) {
    var fs = normFields(fields), out = {}, cl = {}, i;
    for (i = 0; i < (clear || []).length; i++) cl[clear[i]] = true;
    for (i = 0; i < fs.length; i++) {
      var k = fs[i].key;
      var t = typed && Object.prototype.hasOwnProperty.call(typed, k) ? trim(typed[k]) : "";
      out[k] = t ? t : (cl[k] ? "" : trim(cur ? cur[k] : ""));
    }
    return out;
  }

  /**
   * 接手別台改過的資料時，這個 App 的欄位宣告要用哪一份。
   * ⚠️ **舊版的後台根本不認得 fields，送上來的 app 物件裡沒有這個鍵**。
   *    那是「這版不認得」，不是「他要清空」——沒有這個鍵就保留我們原本的宣告。
   *    真的要清掉的話，新版會送 `fields: []`（有這個鍵、值是空陣列），那才照做。
   */
  function adoptFields(incoming, prev) {
    var has = incoming && typeof incoming === "object" &&
      Object.prototype.hasOwnProperty.call(incoming, "fields");
    return has ? normFields(incoming.fields) : normFields(prev && prev.fields);
  }

  /* 現成的欄位組合：Benson 只要按一下，不用自己想代號要打什麼 */
  var PRESETS = [
    {
      id: "movie-library",
      label: "好雷嗎（TMDB ＋ OMDb）",
      fields: [
        { key: "tmdb", label: "TMDB 金鑰", hint: "API Key (v3 auth)，32 碼那組（不是 eyJ… 開頭那個長的）", optional: false },
        { key: "omdb", label: "OMDb 金鑰", hint: "8 碼；沒有就留空，那個 App 少三個分數還是能用", optional: true }
      ]
    }
  ];
  function presetFor(appId) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === appId) return PRESETS[i];
    return null;
  }

  return {
    MAX_FIELDS: MAX_FIELDS,
    normKey: normKey, normFields: normFields, isMulti: isMulti,
    looksSecret: looksSecret, safeHint: safeHint,
    compose: compose, parse: parse, validate: validate, maskSummary: maskSummary,
    maskField: maskField, maskedFields: maskedFields, merge: merge, adoptFields: adoptFields,
    PRESETS: PRESETS, presetFor: presetFor
  };
});
