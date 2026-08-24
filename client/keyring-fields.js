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
    compose: compose, parse: parse, validate: validate, maskSummary: maskSummary,
    maskField: maskField, maskedFields: maskedFields, merge: merge, adoptFields: adoptFields,
    PRESETS: PRESETS, presetFor: presetFor
  };
});
