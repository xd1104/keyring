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
    /* ⚠️ 標準 base64（有 + / =）以前整組漏掉，而**這個系統自己最要命的兩樣東西正是這一型**：
     *    users[].dk（每個人的派生金鑰，44 碼）與 vault.key 裡的 key（解 vault.json 的金鑰，44 碼）。
     *    上面那條的字元集沒有 + / =，所以那兩種金鑰材料一路暢行 —— 這是 2026-08-28 QA 抓到的。 */
    if (/^[A-Za-z0-9+/]{16,}={0,2}$/.test(t)) return true;
    return false;
  }

  /** 顯示用的說明：像金鑰就不要印出來，改印一句叫他去搬走的話。 */
  function safeHint(s) {
    return secretishDeep(s)
      ? "⚠ 這一格的說明看起來像一把金鑰，已隱藏。金鑰請填在上面的輸入框，並把說明清空。"
      : trim(s);
  }

  /** 顯示用的標題。2026-08-24 第二次踩到：擋掉「說明」之後，金鑰改被填進**標題**——
   *  因為宣告欄位的表單從頭到尾沒有讓人填值的地方，他只會挑最像的那一格。
   *  標題不能整個藏掉（那格就沒名字了），所以退回用代號當標題並標記。 */
  function safeLabel(label, key) {
    return secretishDeep(label) ? (trim(key) || "這一格") + "（⚠ 標題看起來像金鑰，已隱藏）" : trim(label);
  }

  /** 寫入端的守門：標題／說明都不准放金鑰。回空字串＝沒問題。 */
  function badFieldText(fields) {
    var list = Array.isArray(fields) ? fields : [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i] || {};
      var where = secretishDeep(f.label) ? "標題" : (secretishDeep(f.hint) ? "說明" : "");
      if (where) {
        /* 這串是丟進 toast 的**純文字**，不要用 markdown 的星號（會原樣顯示出來）。 */
        return "「" + (secretishDeep(f.label) ? (trim(f.key) || "其中一格") : (trim(f.label) || trim(f.key))) +
          "」的" + where + "欄裡是一把金鑰。這張表單只有代號／標題／說明，" +
          "沒有一格是填金鑰的——把它清空、按存檔，接著就會跳出填金鑰的畫面。";
      }
    }
    return "";
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

  /* ==================================================================
   * 公開模式（2026-08-24）
   * ------------------------------------------------------------------
   * 有些 App 用的根本不是憑證，是**免費查詢金鑰**（電影評分的 TMDB／OMDb）。
   * 那種 App 不該有登入畫面：打開網址就要能用。
   * 做法：標成「公開」的 App，值**不加密**、直接以明文寫進公開的 keyring.json，
   *      不綁任何使用者、不需要密碼。
   *
   * ⚠️ 代價 Benson 已經知道並接受：**任何人拿得到那組金鑰**。
   *    最壞是額度被別人用掉，重新產一組就好。
   * ⛔ 但 GitHub PAT 絕對不行——那兩把有 repo 寫入權，外流是災難。
   *    所以下面這道 looksLikeGithubToken 是**硬防線**，前端擋一次、server 擋一次、
   *    連產生 keyring.json 的那一刻還要再擋一次（值可能是「標成公開之後」才被換掉的）。
   * ================================================================== */

  /* GitHub token 的長相。github_pat_（fine-grained）與 gh[porsu]_（classic／OAuth／server／refresh） */
  var GH_TOKEN_RE = /(github_pat_[A-Za-z0-9_]{10,}|\bgh[porsu]_[A-Za-z0-9]{20,})/i;

  /** 這串字裡面有沒有長得像 GitHub token 的東西 */
  function looksLikeGithubToken(v) { return GH_TOKEN_RE.test(str(v)); }

  /**
   * 這個 App 可不可以標成公開？不行的話回一句人話，可以就回 ""。
   * 逐格檢查（多欄位）＋整串檢查（單欄位／拆不開的舊資料）。
   */
  function publicBlockReason(app) {
    var token = str(app && app.token);
    if (!token.trim()) return "";               /* 還沒有值，等他填的時候再擋 */
    var fs = normFields(app && app.fields), i;
    if (fs.length) {
      var r = parse(fs, token);
      if (r.ok) {
        for (i = 0; i < fs.length; i++) {
          if (looksLikeGithubToken(r.values[fs[i].key])) {
            return "「" + fs[i].label + "」看起來是 GitHub token。GitHub token 有 repo 寫入權，"
              + "**絕對不可以**公開。公開模式只能放像 TMDB／OMDb 那種免費查詢金鑰。";
          }
        }
        return "";
      }
    }
    if (looksLikeGithubToken(token)) {
      return "這個 App 的金鑰看起來是 GitHub token。GitHub token 有 repo 寫入權，"
        + "**絕對不可以**公開。公開模式只能放像 TMDB／OMDb 那種免費查詢金鑰。";
    }
    return "";
  }

  /** 勾公開之前要讓他看到的警告（兩個後台共用同一段話） */
  var PUBLIC_WARNING = "這個 App 的金鑰會以**明文**放在公開的 GitHub repo，任何人都看得到。"
    + "只有像 TMDB 這種免費查詢金鑰可以這樣放；GitHub token、密碼、任何有寫入權的東西絕對不行。";

  /**
   * 接手別台改過的資料時，「公開」這個旗標要用哪一份。
   * 跟 adoptFields 同一條規則：舊版後台送上來的資料**沒有這個鍵**＝「這版不認得」，
   * 不是「他要關掉公開」→ 保留原本的設定。
   */
  function adoptPublic(incoming, prev) {
    var has = incoming && typeof incoming === "object" &&
      Object.prototype.hasOwnProperty.call(incoming, "public");
    return has ? !!incoming.public : !!(prev && prev.public);
  }

  /* ==================================================================
   * 開場外觀（splash，2026-08-25）
   * ------------------------------------------------------------------
   * 每個 App 啟動時中央那一塊：一個色塊符號、下面 App 名字、再下面一句標語。
   * 以前那四樣寫死在各 App 的程式碼裡，要改就得回去改程式。現在宣告在後台，
   * 跟著公開的 keyring.json 一起發布，App 下次啟動就跟著變。
   *
   * ⭐ 這是**純顯示用的公開明文**，跟 PAT 密文完全無關 —— 跟 public／plain 同一層級。
   *    它不進任何密文、不碰解密流程；App 讀不到就用自己原本的預設值。
   * ⭐ 每一項都可選，整個 splash 也可以不存在。**空值一律不寫進 JSON**：
   *    「這個鍵不在」＝「這一項 App 自己決定」，語意才乾淨，公開檔也不會塞一堆空字串。
   * ================================================================== */

  var SPLASH_MAX = { name: 24, tagline: 40 };   /* 開場那一塊放不下長句，超過就是版面事故 */
  var SPLASH_COLOR_KEYS = ["bg", "accent", "ink"];
  /* 預覽用的預設色（跟工單上的範例同一組）。⚠️ 這只是**後台縮圖畫給他看**用的，
   * 不會被寫進 keyring.json —— App 端沒讀到那個鍵時要用的是 App 自己的預設。 */
  var SPLASH_DEFAULTS = { bg: "#101820", accent: "#3a7bd5", ink: "#e6edf3" };
  var HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

  /** 色票正規化：只收 #rgb／#rrggbb，一律轉成小寫六碼。看不懂就回 ""（＝沒設定）。 */
  function normColor(v) {
    var t = trim(v).toLowerCase();
    if (!HEX_RE.test(t)) return "";
    if (t.length === 4) t = "#" + t.charAt(1) + t.charAt(1) + t.charAt(2) + t.charAt(2) + t.charAt(3) + t.charAt(3);
    return t;
  }

  /* 會黏在前一個字上的碼位（合字符號、變體選擇子、膚色、keycap）。
   * 刻意用碼位範圍而不是 \p{M}：這支要在很舊的瀏覽器裡也能跑，不用 unicode property escape。 */
  function isGlue(cp) {
    return (cp >= 0x0300 && cp <= 0x036F) || (cp >= 0xFE00 && cp <= 0xFE0F) ||
      (cp >= 0x1F3FB && cp <= 0x1F3FF) || cp === 0x20E3 || (cp >= 0x1AB0 && cp <= 0x1AFF) ||
      (cp >= 0x20D0 && cp <= 0x20F0);
  }
  /** 是不是「區域指示符號」（兩個湊成一面國旗：🇹🇼 ＝ T ＋ W）。單獨一個是半面旗，沒有意義。 */
  function isRegional(cp) { return cp >= 0x1F1E6 && cp <= 0x1F1FF; }

  /**
   * 把字串切成「一個一個看得見的字」（字素）。
   * 一個字素 ＝ 基底字 ＋ 後面黏著的東西：合字符號／變體選擇子／膚色／keycap／ZWJ 組合；
   * 國旗是特例：**兩個區域指示符號才算一個**（🇹🇼 切一半會變成 🇹）。
   */
  function graphemes(v) {
    var t = str(v), cps = [], i = 0, cp;
    while (i < t.length) { cp = t.codePointAt(i); cps.push(cp); i += cp > 0xFFFF ? 2 : 1; }
    var out = [], cur;
    i = 0;
    while (i < cps.length) {
      cur = [cps[i]];
      if (isRegional(cps[i]) && i + 1 < cps.length && isRegional(cps[i + 1])) { cur.push(cps[i + 1]); i += 2; }
      else i++;
      while (i < cps.length) {
        if (isGlue(cps[i])) { cur.push(cps[i]); i++; continue; }
        if (cps[i] === 0x200D && i + 1 < cps.length) { cur.push(cps[i], cps[i + 1]); i += 2; continue; }
        break;
      }
      out.push(String.fromCodePoint.apply(String, cur));
    }
    return out;
  }
  /** 取「第一個字」：一個漢字、一個字母、或一個完整的 emoji（含 ZWJ 組合、膚色、國旗、變體選擇子）。 */
  function firstGrapheme(v) {
    var t = trim(v);
    return t ? graphemes(t)[0] : "";
  }
  /**
   * 按**字素**切長度，不是按 UTF-16 碼元。
   * ⚠️ slice(0,n) 會在尾端留下**半個代理對**，而這串字是要寫進公開 keyring.json 的
   *    —— App 端會顯示成一個 �。長度上限本來就是「看得見幾個字」的意思，用字素才對得上。
   */
  function sliceGraphemes(v, n) {
    var t = trim(v);
    if (!t) return "";
    var g = graphemes(t);
    return g.length <= n ? t : g.slice(0, n).join("");
  }
  /** 開場符號：**只留一個字元**（後台 UI 也會即時擋，這裡是最後一道）。 */
  function normGlyph(v) { return firstGrapheme(v); }

  /**
   * 正規化整組 splash：認得的鍵才留、空的一律丟掉。
   * 回傳 null＝這個 App 沒有任何開場設定（那就整個鍵都不要寫進去）。
   */
  function normSplash(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    var out = {}, n = 0, i, k;
    var name = sliceGraphemes(v.name, SPLASH_MAX.name);
    if (name) { out.name = name; n++; }
    var glyph = normGlyph(v.glyph);
    if (glyph) { out.glyph = glyph; n++; }
    for (i = 0; i < SPLASH_COLOR_KEYS.length; i++) {
      k = SPLASH_COLOR_KEYS[i];
      var c = normColor(v[k]);
      if (c) { out[k] = c; n++; }
    }
    var tag = sliceGraphemes(v.tagline, SPLASH_MAX.tagline);
    if (tag) { out.tagline = tag; n++; }
    return n ? out : null;
  }

  /**
   * 接手別台改過的資料時，開場外觀要用哪一份。
   * 跟 adoptFields／adoptPublic 同一條規則：舊版後台送上來的資料**沒有這個鍵**
   * ＝「這版不認得」，不是「他要清掉」→ 保留原本的設定。
   * 真的要清掉的話，新版會送 `splash: null`（有這個鍵、值是 null）。
   */
  function adoptSplash(incoming, prev) {
    var has = incoming && typeof incoming === "object" &&
      Object.prototype.hasOwnProperty.call(incoming, "splash");
    return has ? normSplash(incoming.splash) : normSplash(prev && prev.splash);
  }

  /**
   * 畫縮圖（跟 App 端的開場）要用的實際值：沒設定的項目補上預覽預設值。
   * ⚠️ 只給畫面用，**不要拿它的結果去存檔**（那樣就把預設值寫死進公開檔了）。
   */
  function splashView(app) {
    var a = app || {}, sp = normSplash(a.splash) || {};
    var name = sp.name || trim(a.name) || "App";
    return {
      name: name,
      glyph: sp.glyph || normGlyph(name) || "●",
      bg: sp.bg || SPLASH_DEFAULTS.bg,
      accent: sp.accent || SPLASH_DEFAULTS.accent,
      ink: sp.ink || SPLASH_DEFAULTS.ink,
      tagline: sp.tagline || ""
    };
  }

  /* ⭐ 符號本身的字色**不是設定項、不進契約**（PM 2026-08-25 拍板）：
   *    多一個色票給他調，就多一種「調成看不見」的可能（keyring 那顆透明按鈕的教訓：
   *    外觀壞掉純功能測試抓不到）。**而它之所以站得住腳，是因為下面這個算法有下界**——
   *    白字與深字各算一次真正的對比度、取高的那個，最差情況也有保證（實測 4.28:1），
   *    不是「猜得準」。少一個他要懂的東西，而且不可能被調成看不見。
   *    ⚠️ 這一段與 app-template 那一端**逐字相同**，改要兩邊一起改。 */
  /* 符號字色：白字與深字各算一次 WCAG 對比度，取高的那個。
     ⚠️ 不要改回「亮度 > 門檻」那種猜法——飽和的綠／青會被誤判成暗底而給白字，
        實測最差只有 2.08:1（全色域 6.8% 低於 3:1）。這裡的 gamma 校正不是裝飾。 */
  function relLum(hex){
    var h = String(hex||"").replace("#","");
    /* 帶 alpha 的 4／8 碼：丟掉 alpha 再算。
       ⚠️ 這是第二道防線：上游 normColor() 只收 3／6 碼，但 keyring.json 是可以手改的，
          而我們對外宣稱的是「不可能被調成看不見」——不能因為上游收窄了就假設不會發生。
          （沒這一段的話 #ffffffff 會被當成 0＝純黑 → 給白字 → 白底白字 1.00:1） */
    if(h.length === 4){ h = h.slice(0,3); }
    if(h.length === 8){ h = h.slice(0,6); }
    if(h.length === 3){ h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2]; }
    if(!/^[0-9a-fA-F]{6}$/.test(h)){ return 0; }
    var c = [0,2,4].map(function(i){
      var v = parseInt(h.substr(i,2),16) / 255;
      return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
    });
    return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2];
  }
  function contrast(l1, l2){
    var hi = Math.max(l1,l2), lo = Math.min(l1,l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  var ON_LIGHT = "#ffffff";
  var ON_DARK  = "#1a1310";
  function onColor(bg){
    var L = relLum(bg);
    var w = contrast(1, L);               /* 白字 */
    var d = contrast(relLum(ON_DARK), L); /* 深字 */
    if(w >= d){ return ON_LIGHT; }
    /* 近乎平手（差距 <15%）時偏好白字：兩者都夠讀，但深字會讓符號從
       「發光的徽章」變成「挖空的洞」，跟開場其餘的淺色字分屬兩套語言。
       ⚠️ 這個 15% 是拿「最差對比」換來的，動它之前先跑全色域斷言。 */
    return (d - w) / d < 0.15 ? ON_LIGHT : ON_DARK;
  }

  /**
   * 開場外觀是**公開明文**（會直接躺在公開 repo 的 keyring.json 裡）。
   * 名字／標語是自由文字，而這個專案已經有過**兩次**「金鑰被貼進自由文字欄」的前科
   * （說明、標題，見上面 hint／label 那段），所以寫入端一樣要守一次。回空字串＝沒問題。
   *
   * ⚠️ 守門用的是**同一支 looksSecret()**，不是另外寫一套「像不像 GitHub token」——
   *    只擋 GitHub token 的話，TMDB 的 32 碼十六進位、sk-proj-…、AIzaSy… 全部照過。
   *    規則分岔成兩套，遲早只修得到一邊（這個 repo 已經吃過那個虧）。
   */
  function splashBlockReason(sp) {
    var s = normSplash(sp);
    if (!s) return "";
    var keys = ["name", "tagline", "glyph"], i, where;
    for (i = 0; i < keys.length; i++) {
      if (secretishDeep(s[keys[i]])) {
        where = keys[i] === "tagline" ? "標語" : keys[i] === "name" ? "開場名字" : "符號";
        /* ⚠️ 這句是丟進 toast 的**純文字**，不要加 markdown（星號會原樣顯示成亂碼）。
         *    手冊 D 段記過一次，這裡第二次踩到——三條路（手機 toast／電腦 toast／server 的 400）
         *    吃的都是這一個字串，所以只要有人在這裡「順手排版」，三個地方一起壞。
         * ⚠️ 而且**出路要講在前面**：他是在被擋下來、正在困惑的當下讀這句話，
         *    先罵人再給解法，他得讀完整句才知道怎麼過關。 */
        return "「" + where + "」那一格中間加個空格、或改短一點就可以存了。"
          + "現在這串看起來像一把金鑰，而開場外觀會原樣公開在網路上（任何人都看得到），所以先擋下來。";
      }
    }
    return "";
  }

  /* ==================================================================
   * 啟動頁的公開檔 apps.json（2026-08-28）
   * ------------------------------------------------------------------
   * `https://xd1104.github.io/keyring/` 是一頁**免密碼**的 App 啟動頁（加主畫面用）。
   * 它讀的 apps.json 是這個 repo 裡**唯一新增的公開檔**：
   *   ⛔ 一個位元組的祕密都不能有 —— 沒有 token／plain／iv／cipher／kdf／salt／users。
   *   ⭐ 用**白名單**產生（只寫下面列的鍵），不是「把危險的鍵刪掉」：
   *      黑名單漏一個新欄位就外洩，白名單漏一個只是少顯示一樣東西。
   *
   * ⚠️ 這支 buildApps() 是**唯一的產生器**，server.js（電腦端）與 web/admin.js（手機端）
   *    都呼叫它。這個專案已經因為「同一條規則活在兩套實作裡」出過事
   *    （金鑰沿用只修了電腦端），所以規則只准有一份，驗收要證明兩端**逐位元組相同**。
   * ================================================================== */

  var APPS_VERSION = 1;
  /* 白名單：apps.json 裡准許出現的鍵，就這些（tools/check-public.js 拿同一份去比對） */
  var APPS_TOP_KEYS = ["version", "generatedAt", "apps"];
  var APPS_ITEM_KEYS = ["id", "name", "emoji", "url", "repo", "order", "keyed", "key"];
  var APPS_KEY_KEYS = ["expiresAt", "source", "checkedAt", "state"];
  var KEY_STATES = ["ok", "soon", "expired", "none", "unknown"];
  /* 兩段門檻（刻意不同）：後台的 chip 早一點提醒，他每天看的啟動頁晚一點才吵他 */
  var KEY_SOON_DAYS = 30;    /* 後台卡片的 chip 轉琥珀 */
  var KEY_ALERT_DAYS = 14;   /* 啟動頁才跳提醒帶 */

  var REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var HTTP_RE = /^https?:\/\/[^\s]+$/;

  /** `owner/name`。也吃得下整條 GitHub 網址；看不懂就回 ""（＝沒設定，不要亂猜） */
  function normRepo(v) {
    var t = trim(v).replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    return REPO_RE.test(t) ? t : "";
  }
  /** 從 App 網址推導 repo（推不出就回 ""，畫面顯示「—」，不要猜一個錯的出來） */
  function repoFromUrl(url) {
    var t = trim(url);
    var m = /^https?:\/\/([A-Za-z0-9-]+)\.github\.io\/([A-Za-z0-9_.-]+)\/?/.exec(t);
    if (m) return normRepo(m[1] + "/" + m[2]);
    m = /^https?:\/\/([A-Za-z0-9-]+)\.github\.io\/?$/.exec(t);
    if (m) return normRepo(m[1] + "/" + m[1] + ".github.io");
    m = /^https?:\/\/(www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(t);
    if (m) return normRepo(m[2] + "/" + m[3]);
    return "";
  }
  function normDate(v) {
    var t = trim(v);
    return DATE_RE.test(t) ? t : "";
  }
  /**
   * GitHub 回應標頭 `github-authentication-token-expiration: 2026-12-02 07:00:00 +0800`
   * → `2026-12-02`。沒有這個標頭＝這把不會過期，回 ""。
   * ⚠️ 刻意取**標頭上那個日期本身**，不換算 UTC：GitHub 網頁上顯示的就是這一天，
   *    換算之後會變成 12-01，跟他自己去 GitHub 看到的對不起來（差一天比不準更煩）。
   *    倒數本來就只用在 14／30 天的門檻上，差幾小時不影響。
   * ⚠️ 不用 new Date(字串) 解析：那個格式各家實作認不認得不一樣。
   */
  function expiryFromHeader(h) {
    var d = /(\d{4})-(\d{2})-(\d{2})/.exec(str(h));
    return d ? d[0] : "";
  }

  /**
   * 到期偵測的**結果快取**（存在 secrets.json／vault.json 的 apps[].keyExp，不是設定）。
   * state：ok（有到期日）／none（不會過期）／expired（401，已失效）／unknown（測不到）
   */
  function normKeyExp(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    var st = trim(v.state);
    if (KEY_STATES.indexOf(st) < 0) st = "";
    var at = trim(v.checkedAt);
    var out = {
      expiresAt: normDate(v.expiresAt) || null,
      source: trim(v.source) === "manual" ? "manual" : "auto",
      /* checkedAt 會進公開檔，只收 ISO 時間戳的長相（別的東西一律當成沒有） */
      checkedAt: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(at) ? at : null,
      state: st || (normDate(v.expiresAt) ? "ok" : "unknown")
    };
    if (!out.expiresAt && !out.checkedAt && out.state === "unknown") return null;
    return out;
  }

  /**
   * 算出「現在」這把金鑰是什麼狀態。**啟動頁就是拿這支在本機算倒數的**：
   * 到期日是固定的未來日期，測到一次之後不用再連線 —— 快照過期不會讓提醒失效。
   * ⚠️ 測不到（unknown）**不可以畫成沒事**：第一次使用會看到一片綠、其實一條都沒測。
   */
  function keyExpState(keyExp, nowIso) {
    var k = normKeyExp(keyExp);
    var base = { state: "unknown", days: null, expiresAt: null, source: "auto", checkedAt: null };
    if (!k) return base;
    base.expiresAt = k.expiresAt; base.source = k.source; base.checkedAt = k.checkedAt;
    if (k.state === "expired") { base.state = "expired"; base.days = k.expiresAt ? dayDiff(k.expiresAt, nowIso) : null; return base; }
    if (k.state === "none") { base.state = "none"; return base; }
    if (!k.expiresAt) { base.state = k.state === "ok" ? "unknown" : k.state; return base; }
    var d = dayDiff(k.expiresAt, nowIso);
    base.days = d;
    base.state = d < 0 ? "expired" : (d <= KEY_SOON_DAYS ? "soon" : "ok");
    return base;
  }
  function dayDiff(dateStr, nowIso) {
    var a = Date.parse(dateStr + "T00:00:00Z");
    var b = Date.parse(trim(nowIso) || new Date().toISOString());
    if (isNaN(a) || isNaN(b)) return null;
    return Math.floor((a - b) / 86400000);
  }
  /** chip／提醒帶的文案（兩個後台與啟動頁共用一份，免得三個地方各講各的） */
  function keyLabel(st) {
    if (!st) return "";
    if (st.state === "expired") return "金鑰已過期";
    if (st.state === "soon") return "金鑰還有 " + st.days + " 天";
    if (st.state === "none") return "金鑰不會過期";
    if (st.state === "unknown") return "還沒檢查過";
    return "金鑰還有 " + st.days + " 天";
  }

  /**
   * 產生 apps.json（**白名單**：只寫下面列出來的鍵）。
   * state = { apps:[ …secrets/vault 的 apps[]… ], generatedAt:"ISO" }
   *
   * ⚠️ name／emoji／url／repo 都是**自由文字**，而這個專案已經有三次「金鑰被貼進自由文字欄」
   *    的前科（說明、標題、開場名字）。這裡中了就**整份產生失敗**並把原因講出來，
   *    不做靜靜降級 —— 跟公開模式那條方向相反，因為這裡沒有「安全的替代值」可以倒。
   */
  /**
   * 一看就是「代號」的字串：全小寫、用 - 或 . 分段、每一段都不長。
   * ⚠️ 這個例外是必要的：App 的 id／名字本來就常常是 `brain-boosting-games` 這種
   *    20 幾個字的 slug，而 looksSecret() 對「夠長的不透明 ASCII」一律judge成金鑰——
   *    不開這個口的話，登記一個英文名字的 App 會被自己的防線擋下來。
   * ⚠️ 開口開得很窄：只要有大小寫混雜、底線、或任何一段超過 15 個字就不算 slug；
   *    GitHub token 與長十六進位（TMDB 那種）也明確排除。
   */
  function looksLikeSlug(v) {
    var t = trim(v), seg, i, flat;
    if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)+$/.test(t)) return false;
    if (looksLikeGithubToken(t) || /^[0-9a-f]{16,}$/i.test(t)) return false;
    seg = t.split(/[-.]/);
    for (i = 0; i < seg.length; i++) if (seg[i].length > 15) return false;
    /* ⚠️ 「有分段而且每段都短」不能當成「這是代號」的證據：UUID 剛好是 8-4-4-4-12，
     *    任何用 - 或 . 切碎的金鑰也一樣。所以把分隔符拿掉再看一次：整串是夠長的純十六進位
     *    就不是代號。（beef-cafe 這種短的照樣放行，不會誤擋正常的 App 代號） */
    flat = t.replace(/[-.]/g, "");
    if (/^[0-9a-f]{16,}$/.test(flat)) return false;
    return true;
  }
  /** apps.json 那條路上的「像不像金鑰」：looksSecret 但排掉單純的代號 */
  function secretish(v) { return looksSecret(v) && !looksLikeSlug(v); }
  /**
   * 自由文字裡**夾著**金鑰也要抓得到（2026-08-28 QA R-2 退件）。
   * ------------------------------------------------------------------
   * 洞在 looksSecret() 第一行的 `有空白＝是句子不是金鑰`：那個推論只對「整格剛好等於
   * 一把金鑰」成立。實際上最自然的貼法是**前後帶著字**——
   *   「電影 c1209585…」「我的金鑰是 … 別外流」「token: github_pat_…」
   * 舊規則整串一律放行，而那串會原樣被 push 到公開的 apps.json。
   * 多欄位的整串 {"tmdb":"…","omdb":"…"} 也是同一個洞（引號括號讓整串不像金鑰），
   * 切成 token 之後就一併解決，不必為它另開特例。
   *
   * 作法：把自由文字沿「不可能出現在金鑰裡的字元」切開，任何一段像金鑰就算中。
   * 分隔符刻意**保留** + / = _ . -（base64／PAT／UUID 都會用到，切掉就等於自己把證據弄碎）。
   */
  function secretishDeep(v) {
    var t = trim(v), i;
    if (!t) return false;
    if (secretish(t)) return true;
    /* GitHub token 是災難等級（有 repo 寫入權），所以整串「找得到就算中」，
     * 不管它前後黏了什麼：token=github_pat_… / ?token=… / 「我的 token 是 …」。 */
    if (looksLikeGithubToken(t)) return true;
    /* 切兩次：第一次保留 = （base64 的 padding 在字尾），第二次連 = 也切開
     * （key=value 這種寫法會把金鑰跟前面的字黏成同一段，第一次切不出來）。 */
    if (anyPartSecret(t, /[^A-Za-z0-9+/=_.-]+/)) return true;
    if (anyPartSecret(t, /[^A-Za-z0-9+/_.-]+/)) return true;
    return false;
  }
  function anyPartSecret(t, sep) {
    var parts = t.split(sep), i;
    for (i = 0; i < parts.length; i++) {
      if (parts[i] && parts[i] !== t && secretish(parts[i])) return true;
    }
    return false;
  }


  function appsBlockReason(apps) {
    var list = Array.isArray(apps) ? apps : [], i, a, where;
    for (i = 0; i < list.length; i++) {
      a = list[i] || {};
      /* ⚠️ 一律用 secretishDeep()：金鑰被「前後帶著字」貼進來才是最常見的貼法。
       *    網址也不例外——https://…/?token=github_pat_… 這種同樣要擋（以前 HTTP_RE 一過就跳過了）。 */
      where = secretishDeep(a.name) ? "名字" : (secretishDeep(a.emoji) ? "圖示" :
        (secretishDeep(a.repo) ? "GitHub repo" : (secretishDeep(a.url) ? "網址" : "")));
      if (where) {
        return "「" + (trim(a.id) || "其中一個 App") + "」的" + where + "那一格看起來像一把金鑰。"
          + "啟動頁的清單會原樣公開在網路上（任何人都看得到），所以這次整份沒有產生。"
          + "把那一格改成給人看的字再存一次就好。";
      }
      if (trim(a.url) && !HTTP_RE.test(trim(a.url))) {
        return "「" + (trim(a.id) || "其中一個 App") + "」的網址不是一條網址（要 http:// 或 https:// 開頭）。"
          + "啟動頁的磚塊就是靠它開 App 的，先改對再存。";
      }
    }
    return "";
  }

  function buildApps(state) {
    var st = state || {};
    var list = Array.isArray(st.apps) ? st.apps : [];
    var why = appsBlockReason(list);
    if (why) throw new Error(why);
    var stamp = trim(st.generatedAt) || new Date().toISOString();
    var rows = list.map(function (a, i) {
      return { a: a || {}, i: i, o: (typeof (a && a.order) === "number" && isFinite(a.order)) ? a.order : i };
    });
    /* 順序固定（Benson 拍板）：照 order，沒有 order 的照原陣列順序。
       ⚠️ 不要改成「最近更新排前面」—— 位置每天跳，肌肉記憶就沒了。 */
    rows.sort(function (x, y) { return x.o === y.o ? x.i - y.i : x.o - y.o; });
    return {
      version: APPS_VERSION,
      generatedAt: stamp,
      apps: rows.map(function (r, idx) {
        var a = r.a;
        var url = trim(a.url);
        var keyed = !!trim(a.token);
        var out = {
          id: trim(a.id),
          name: trim(a.name),
          emoji: trim(a.emoji) || "📦",
          url: url,
          repo: normRepo(a.repo) || repoFromUrl(url),
          order: idx,
          keyed: keyed
        };
        if (keyed) {
          var k = keyExpState(a.keyExp, stamp);
          out.key = {
            expiresAt: k.expiresAt || null,
            source: k.source,
            checkedAt: k.checkedAt || null,
            state: k.state
          };
        }
        return out;
      })
    };
  }
  /** 產出物的文字形式：兩端都用這一支，才能逐位元組相同（縮排、結尾換行都算） */
  function appsJsonText(state) { return JSON.stringify(buildApps(state), null, 2) + "\n"; }

  /* ==================================================================
   * 變更紀錄：把「誰改的」寫進 commit message（2026-08-28）
   * ------------------------------------------------------------------
   * git 的 author 沒有用：電腦端一律是 LAPTOP-…\USER，手機端是走 GitHub API 送的，
   * 黏 跟 肚 的 author 都是 xd1104。所以人名要自己寫進 message 的 trailer。
   * 兩端共用這一份格式，手機那邊不必 diff 任何檔案就畫得出一整頁。
   * ================================================================== */

  var COMMIT_PREFIX = "鑰匙圈：";
  var BY_RE = /^by:\s*([^·\n]*?)\s*·\s*(.+?)\s*$/m;

  /** 兩份 keyring.json（本來就是明文）的結構差異 → 人話。⚠️ vault.json 是密文，永遠不 diff。
   *  ⚠️ 密文（cipher）每次存檔都會變（IV 是隨機的），所以**不能**拿它判斷「換了金鑰」——
   *     那件事由呼叫端自己講（它才知道剛剛做了什麼）。 */
  function summarizeChange(before, after) {
    var b = before || {}, a = after || {}, out = [];
    var bApps = idx(b.apps), aApps = idx(a.apps);
    var bUsers = idx(b.users), aUsers = idx(a.users);
    var k;
    for (k in aApps) if (own(aApps, k) && !own(bApps, k)) out.push("新增 App「" + nm(aApps[k]) + "」");
    for (k in bApps) if (own(bApps, k) && !own(aApps, k)) out.push("移除 App「" + nm(bApps[k]) + "」");
    for (k in aApps) {
      if (!own(aApps, k) || !own(bApps, k)) continue;
      if (nm(aApps[k]) !== nm(bApps[k])) out.push("把 App「" + nm(bApps[k]) + "」改名成「" + nm(aApps[k]) + "」");
      if (!!aApps[k].public !== !!bApps[k].public) {
        out.push((aApps[k].public ? "把「" : "關掉「") + nm(aApps[k]) + (aApps[k].public ? "」設成公開模式" : "」的公開模式"));
      }
      if (JSON.stringify(aApps[k].splash || null) !== JSON.stringify(bApps[k].splash || null)) {
        out.push("改了「" + nm(aApps[k]) + "」的開場外觀");
      }
    }
    for (k in aUsers) if (own(aUsers, k) && !own(bUsers, k)) out.push("新增成員「" + nm(aUsers[k]) + "」");
    for (k in bUsers) if (own(bUsers, k) && !own(aUsers, k)) out.push("移除成員「" + nm(bUsers[k]) + "」");
    for (k in aUsers) {
      if (!own(aUsers, k) || !own(bUsers, k)) continue;
      if (nm(aUsers[k]) !== nm(bUsers[k])) out.push("把成員「" + nm(bUsers[k]) + "」改名成「" + nm(aUsers[k]) + "」");
      var was = appIdsOf(bUsers[k]), now = appIdsOf(aUsers[k]), i;
      for (i = 0; i < now.length; i++) if (was.indexOf(now[i]) < 0) out.push("讓「" + nm(aUsers[k]) + "」也能用「" + appName(aApps, now[i]) + "」");
      for (i = 0; i < was.length; i++) if (now.indexOf(was[i]) < 0) out.push("收回「" + nm(aUsers[k]) + "」的「" + appName(bApps, was[i]) + "」");
    }
    return out;

    function idx(arr) {
      var m = {}, i, list = Array.isArray(arr) ? arr : [];
      for (i = 0; i < list.length; i++) if (list[i] && list[i].id) m[list[i].id] = list[i];
      return m;
    }
    function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function nm(o) { return trim(o && o.name) || trim(o && o.id); }
    function appName(m, id) { return m[id] ? nm(m[id]) : id; }
    function appIdsOf(u) {
      if (!u) return [];
      if (Array.isArray(u.apps)) return u.apps.slice();               /* secrets／vault 的樣子 */
      if (u.apps && typeof u.apps === "object") return Object.keys(u.apps); /* keyring.json 的樣子 */
      return [];
    }
  }

  /** 第一行的人話摘要。呼叫端知道自己做了什麼就用它的話，否則用結構差異推。 */
  function commitTitle(action, diffs) {
    var a = trim(action);
    if (a) return a;
    var d = Array.isArray(diffs) ? diffs.filter(function (x) { return !!trim(x); }) : [];
    if (!d.length) return "更新了鑰匙圈";
    if (d.length <= 2) return d.join("、");
    return d.slice(0, 2).join("、") + " 等 " + d.length + " 項";
  }
  /**
   * commit message（兩端同一份格式）：
   *   鑰匙圈：換了「食譜本」的金鑰
   *   （空行）
   *   by: 肚 · 手機後台
   * 電腦後台沒有登入身分 ⇒ `by: · 電腦後台`（誠實，不要編一個名字出來）。
   */
  function commitMessage(o) {
    var opt = o || {};
    var title = commitTitle(opt.action, opt.diffs);
    var by = trim(opt.by), via = trim(opt.via) || "電腦後台";
    return COMMIT_PREFIX + title + "\n\nby: " + by + " · " + via;
  }
  /** 讀回來：舊 commit 沒有 trailer ⇒ 當成電腦後台＋原始標題，不要留白 */
  function parseCommitMessage(msg) {
    var raw = str(msg).replace(/\r/g, "");
    var first = raw.split("\n")[0];
    var m = BY_RE.exec(raw);
    var title = first.indexOf(COMMIT_PREFIX) === 0 ? first.slice(COMMIT_PREFIX.length) : first;
    return {
      title: trim(title) || "(沒有說明)",
      by: m ? trim(m[1]) : "",
      via: m ? trim(m[2]) : "電腦後台",
      tagged: !!m
    };
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
    looksSecret: looksSecret, safeHint: safeHint, safeLabel: safeLabel, badFieldText: badFieldText,
    compose: compose, parse: parse, validate: validate, maskSummary: maskSummary,
    maskField: maskField, maskedFields: maskedFields, merge: merge, adoptFields: adoptFields,
    looksLikeGithubToken: looksLikeGithubToken, publicBlockReason: publicBlockReason,
    adoptPublic: adoptPublic, PUBLIC_WARNING: PUBLIC_WARNING,
    SPLASH_MAX: SPLASH_MAX, SPLASH_DEFAULTS: SPLASH_DEFAULTS, SPLASH_COLOR_KEYS: SPLASH_COLOR_KEYS,
    normColor: normColor, normGlyph: normGlyph, normSplash: normSplash,
    onColor: onColor,
    adoptSplash: adoptSplash, splashView: splashView, splashBlockReason: splashBlockReason,
    /* 啟動頁的公開檔（白名單產生器，三端共用同一支） */
    APPS_VERSION: APPS_VERSION, APPS_TOP_KEYS: APPS_TOP_KEYS, APPS_ITEM_KEYS: APPS_ITEM_KEYS,
    APPS_KEY_KEYS: APPS_KEY_KEYS, KEY_STATES: KEY_STATES,
    KEY_SOON_DAYS: KEY_SOON_DAYS, KEY_ALERT_DAYS: KEY_ALERT_DAYS,
    normRepo: normRepo, repoFromUrl: repoFromUrl, normDate: normDate, expiryFromHeader: expiryFromHeader,
    normKeyExp: normKeyExp, keyExpState: keyExpState, keyLabel: keyLabel,
    looksLikeSlug: looksLikeSlug, secretish: secretish, secretishDeep: secretishDeep,
    appsBlockReason: appsBlockReason, buildApps: buildApps, appsJsonText: appsJsonText,
    /* 變更紀錄 */
    COMMIT_PREFIX: COMMIT_PREFIX, summarizeChange: summarizeChange, commitTitle: commitTitle,
    commitMessage: commitMessage, parseCommitMessage: parseCommitMessage,
    PRESETS: PRESETS, presetFor: presetFor
  };
});
