"use strict";
/*
 * check-public.js — 公開檔 apps.json 的機器驗收（零依賴，只用 node 內建）
 *
 *   node tools/check-public.js               全部
 *   node tools/check-public.js --file=x.json 驗指定的檔（預設 repo 根目錄的 apps.json）
 *   node tools/check-public.js --only=A,B    A 白名單／B 祕密掃描／C 交叉比對／D 負控組／E 兩端一致
 *
 * 為什麼要有這支：apps.json 是**免密碼的啟動頁**在讀的公開檔，
 * 而這個 repo 已經有三次「金鑰被貼進自由文字欄」的前科（說明、標題、開場名字）。
 * 「掃了沒抓到」有兩種可能：**真的乾淨**，或**尺是壞的**。
 * 所以每一條紅線都配一組**負控組**：故意把假 token 塞進去，抓不到就 exit 2。
 *
 * ⚠️ 負控組全程用**假金鑰**（github_pat_FAKE…），而且只在記憶體裡改一份複本，
 *    不會寫回 apps.json，也不碰 keyring.json／vault.json／secrets.json。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const KF = require(path.join(ROOT, "client", "keyring-fields.js"));

const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").replace("--only=", "");
const wants = (g) => !ONLY || ONLY.split(",").indexOf(g) >= 0;
const FILE = (process.argv.find((a) => a.startsWith("--file=")) || "").replace("--file=", "")
  || path.join(ROOT, "apps.json");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? "  ✅ " : "  ❌ ") + name + (detail ? "\n      " + detail : ""));
}
function head(t) { console.log("\n" + t); }
/* 尺壞了跟「東西有問題」是兩件事，退出碼要分得開：1＝有問題，2＝這支檢查本身不可信 */
let brokenRuler = "";
function ruler(why) { brokenRuler = brokenRuler || why; }

/* ------------------------------------------------------------------ */
/* 掃描器（每一支都獨立，負控組才驗得到「這一把尺是活的」）              */
/* ------------------------------------------------------------------ */

/** 走訪每一個字串值，回傳 [{path, value}] */
function strings(doc) {
  const out = [];
  (function walk(v, p) {
    if (typeof v === "string") { out.push({ path: p, value: v }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + "[" + i + "]")); return; }
    if (v && typeof v === "object") { Object.keys(v).forEach((k) => walk(v[k], p ? p + "." + k : k)); }
  })(doc, "");
  return out;
}

/** A. 白名單：**列准許的，不列禁止的**。黑名單漏一個新欄位就是外洩。 */
function checkWhitelist(doc) {
  const bad = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["整份不是一個物件"];
  Object.keys(doc).forEach((k) => {
    if (KF.APPS_TOP_KEYS.indexOf(k) < 0) bad.push("最外層多了不該有的鍵：" + k);
  });
  if (doc.version !== KF.APPS_VERSION) bad.push("version 不是 " + KF.APPS_VERSION);
  if (typeof doc.generatedAt !== "string") bad.push("generatedAt 不是字串");
  if (!Array.isArray(doc.apps)) return bad.concat("apps 不是陣列");
  doc.apps.forEach((a, i) => {
    const at = "apps[" + i + "]";
    if (!a || typeof a !== "object" || Array.isArray(a)) { bad.push(at + " 不是物件"); return; }
    Object.keys(a).forEach((k) => {
      if (KF.APPS_ITEM_KEYS.indexOf(k) < 0) bad.push(at + " 多了不該有的鍵：" + k);
    });
    ["id", "name", "emoji", "url", "repo"].forEach((k) => {
      if (typeof a[k] !== "string") bad.push(at + "." + k + " 不是字串");
    });
    if (typeof a.order !== "number") bad.push(at + ".order 不是數字");
    if (typeof a.keyed !== "boolean") bad.push(at + ".keyed 不是 true/false");
    if (a.url && !/^https?:\/\//.test(a.url)) bad.push(at + ".url 不是 http(s) 網址");
    if (a.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(a.repo)) bad.push(at + ".repo 不是 owner/name");
    if (!a.keyed && Object.prototype.hasOwnProperty.call(a, "key")) bad.push(at + " 沒有金鑰卻有 key 區塊");
    if (!Object.prototype.hasOwnProperty.call(a, "key")) return;
    const k = a.key;
    if (!k || typeof k !== "object" || Array.isArray(k)) { bad.push(at + ".key 不是物件"); return; }
    Object.keys(k).forEach((x) => {
      if (KF.APPS_KEY_KEYS.indexOf(x) < 0) bad.push(at + ".key 多了不該有的鍵：" + x);
    });
    if (k.expiresAt !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(k.expiresAt))) {
      bad.push(at + ".key.expiresAt 不是 YYYY-MM-DD 也不是 null");
    }
    if (["auto", "manual"].indexOf(k.source) < 0) bad.push(at + ".key.source 只能是 auto／manual");
    if (k.checkedAt !== null && !/^\d{4}-\d{2}-\d{2}T/.test(String(k.checkedAt))) {
      bad.push(at + ".key.checkedAt 不是 ISO 時間也不是 null");
    }
    if (KF.KEY_STATES.indexOf(k.state) < 0) bad.push(at + ".key.state 不在 " + KF.KEY_STATES.join("／"));
  });
  return bad;
}

/** B. 每個字串值都當成可疑的來看：像金鑰就紅。 */
function scanSecrets(doc) {
  const list = strings(doc), bad = [];
  list.forEach((s) => {
    const v = s.value;
    let why = "";
    /* ⚠️ 代號本來就常常是 brain-boosting-games 這種長 slug，會被 looksSecret 誤判成金鑰。
     *    例外用的是 KF.looksLikeSlug()（跟產生器守門那條**同一支**），
     *    不要在這裡另外寫一套「我覺得這個看起來還好」的規則。 */
    if (KF.looksLikeGithubToken(v)) why = "像 GitHub token";
    else if (KF.secretishDeep(v)) why = "像一把金鑰（整串、或句子裡夾著一段）";
    else if (/[0-9a-f]{20,}/i.test(v)) why = "夾著一段 20 碼以上的十六進位";
    else if (/\b[A-Za-z0-9_-]{32,}\b/.test(v) && !/^https?:\/\//.test(v) && !KF.looksLikeSlug(v)) {
      why = "夾著一段 32 碼以上的不透明字串";
    }
    if (why) bad.push(s.path + " " + why + "：" + v.slice(0, 24) + "…");
  });
  return { bad, scanned: list.length };
}

/** C. 交叉比對：apps.json 的任何字串，不得包含 secrets.json 裡任何 token 的 ≥8 字元子字串。 */
function crossCompare(doc, tokens) {
  const list = strings(doc), bad = [];
  tokens.forEach((t) => {
    const tk = String(t || "");
    if (tk.length < 8) return;
    list.forEach((s) => {
      for (let i = 0; i + 8 <= tk.length; i++) {
        const frag = tk.slice(i, i + 8);
        if (s.value.indexOf(frag) >= 0) {
          bad.push(s.path + " 含有金鑰的一段（" + frag.slice(0, 3) + "…）");
          return;
        }
      }
    });
  });
  return bad;
}

/** 本機的明文 token（只在這台電腦有；CI 上沒有就明講「這一段沒測到」） */
function localTokens() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, "secrets.json"), "utf8"));
    const out = [];
    (s.apps || []).forEach((a) => {
      if (!a.token) return;
      out.push(String(a.token));
      /* 多欄位的 App：那串是 JSON，裡面每一把也要各自比對 */
      try {
        const o = JSON.parse(a.token);
        if (o && typeof o === "object") Object.keys(o).forEach((k) => out.push(String(o[k])));
      } catch (e) { /* 單欄位，不是 JSON */ }
    });
    if (s.github && s.github.token) out.push(String(s.github.token));
    return out.filter((x) => x && x.length >= 8);
  } catch (e) { return null; }
}

/* ------------------------------------------------------------------ */
function loadDoc() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    return null;
  }
}
const clone = (o) => JSON.parse(JSON.stringify(o));

const FAKE_PAT = "github_pat_11FAKEFAKE0FAKEfakeFAKEfake1234567890abcdefghijKLMNOP";
const FAKE_HEX = "0f7c1e2b3a4d5e6f7a8b9c0d1e2f3a4b";

function main() {
  console.log("apps.json 公開檔檢查 — " + FILE);
  const doc = loadDoc();
  if (!doc) {
    check("0. 讀得到 apps.json", false, "找不到或不是合法 JSON：" + FILE);
    return finish();
  }
  check("0. 讀得到 apps.json（" + (doc.apps || []).length + " 個 App）", true);

  /* ---------------- A 白名單 ---------------- */
  if (wants("A")) {
    head("A  白名單（只准出現規格上那些鍵）");
    const bad = checkWhitelist(doc);
    check("A1. ★ 整份只有白名單上的鍵、型別也對", bad.length === 0, bad.slice(0, 6).join("\n      "));
    check("A2. 絕對不會出現的那些鍵一個都沒有（token／plain／iv／cipher／kdf／salt／users／pairing）",
      !/["'](token|plain|iv|cipher|kdf|salt|users|pairing|dk)["']\s*:/.test(JSON.stringify(doc)),
      JSON.stringify(doc).slice(0, 120));
  }

  /* ---------------- B 祕密掃描 ---------------- */
  let scanned = 0;
  if (wants("B")) {
    head("B  祕密掃描（每一個字串值都當成可疑的）");
    const r = scanSecrets(doc);
    scanned = r.scanned;
    check("B1. ★ 沒有任何字串長得像金鑰", r.bad.length === 0, r.bad.slice(0, 6).join("\n      "));

    /* 涵蓋範圍自證：掃到的欄位數少於「這份檔案應該有的最少字串數」＝尺壞了 */
    const n = (doc.apps || []).length;
    const keyed = (doc.apps || []).filter((a) => a.keyed).length;
    const expect = 1 /* generatedAt */ + n * 5 /* id,name,emoji,url,repo */ + keyed * 2 /* source,state */;
    check("B2. 掃描量足夠（掃到 " + scanned + " 個字串，至少要有 " + expect + " 個）", scanned >= expect,
      scanned < expect ? "掃太少了 —— 這代表 walker 沒走完，這一組的綠燈不算數" : "");
    if (scanned < expect) ruler("B2 掃描量不足");
  }

  /* ---------------- C 交叉比對 ---------------- */
  if (wants("C")) {
    head("C  交叉比對（跟這台電腦上的真金鑰對照）");
    const tokens = localTokens();
    if (!tokens) {
      console.log("  ⚠️ 這台機器沒有 secrets.json —— **這一段沒測到**（不是通過）。");
      console.log("      交叉比對只在有明文金鑰的那台電腦上跑得起來。");
    } else if (!tokens.length) {
      console.log("  ⚠️ secrets.json 裡一把金鑰都沒有 —— 這一段沒測到。");
    } else {
      const bad = crossCompare(doc, tokens);
      check("C1. ★ apps.json 不含任何真金鑰的 8 字元以上片段（比對了 " + tokens.length + " 把）",
        bad.length === 0, bad.slice(0, 4).join("\n      "));
    }
  }

  /* ---------------- D 負控組 ---------------- */
  if (wants("D")) {
    head("D  負控組（故意把假金鑰塞進去，每一條都必須翻紅）");
    if (!(doc.apps || []).length) {
      console.log("  ⚠️ apps.json 裡沒有 App，負控組沒有東西可以污染 —— 這一段沒測到。");
      ruler("D 沒有 App 可以做負控組");
    } else {
      /* D1 name */
      let m = clone(doc); m.apps[0].name = FAKE_PAT;
      const d1 = scanSecrets(m).bad.length > 0;
      check("D1. ★ 假 token 塞進 name → 掃描器抓得到", d1);
      /* D2 emoji */
      m = clone(doc); m.apps[0].emoji = "ghp_FAKEfakeFAKEfake1234567890abcd";
      const d2 = scanSecrets(m).bad.length > 0;
      check("D2. ★ 假 token 塞進 emoji → 抓得到", d2);
      /* D3 key.expiresAt（沒有 key 區塊就自己補一個來測） */
      m = clone(doc);
      if (!m.apps[0].key) { m.apps[0].keyed = true; m.apps[0].key = { expiresAt: null, source: "auto", checkedAt: null, state: "unknown" }; }
      m.apps[0].key.expiresAt = FAKE_HEX;
      const d3 = scanSecrets(m).bad.length > 0;
      const d3b = checkWhitelist(m).length > 0;
      check("D3. ★ 假金鑰塞進 key.expiresAt → 掃描器與白名單都抓得到", d3 && d3b,
        "掃描器 " + d3 + " / 白名單 " + d3b);
      /* D4 多一個鍵（白名單的本職） */
      m = clone(doc); m.apps[0].token = FAKE_PAT;
      const d4 = checkWhitelist(m).length > 0;
      check("D4. ★ 多長出一個 token 欄位 → 白名單抓得到", d4);
      /* D5 交叉比對本身是活的（用一段不會被 looksSecret 判成金鑰的片段） */
      const frag = "abc-defg";        /* 有連字號、只有 8 碼：looksSecret 不會中 */
      m = clone(doc); m.apps[0].name = "旅途手帳 " + frag;
      const d5self = scanSecrets(m).bad.length === 0;      /* 先證明 B 抓不到它 */
      const d5 = crossCompare(m, ["XX" + frag + "ZZ"]).length > 0;
      check("D5. ★ 交叉比對抓得到「B 組抓不到」的那種片段", d5 && d5self,
        "B 組不該中：" + d5self + " / 交叉比對中：" + d5);


      /* ── D6／D7：2026-08-28 QA 退件補的兩條紅線 ────────────────────────────
       * 當時的 secretish() 有兩個洞，而且是端到端可證的（值原樣出現在 apps.json 裡）：
       *   洞 A：looksLikeSlug() 只看「分段而且每段短」→ **UUID 剛好完全符合**（8-4-4-4-12），
       *         任何用 - 或 . 切碎的金鑰也一樣。
       *   洞 B：looksSecret() 的字元集沒有 + / = → **標準 base64 整組漏掉**，
       *         而這個系統自己的 users[].dk 與 vault.key 的 key 正是這一型。
       * 這兩條都配一組**負控組**：拿「補丁還沒進去的舊規則」跑同一批值，證明舊規則放行、
       * 現在的規則擋下 —— 有人把補丁改回去，這兩條就會紅。
       * ⚠️ 全部是合成值，不是真的金鑰。 */
      const OLD = {
        /* 補丁前的 looksSecret（少了標準 base64 那條） */
        looksSecret: function (t) {
          if (!t || /\s/.test(t)) return false;
          if (/^[0-9a-f]{8,}$/i.test(t)) return true;
          return /^[A-Za-z0-9_\-.]{16,}$/.test(t);
        },
        /* 補丁前的 looksLikeSlug（少了「拿掉分隔符後是純 hex」那條） */
        looksLikeSlug: function (t) {
          if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)+$/.test(t)) return false;
          if (KF.looksLikeGithubToken(t) || /^[0-9a-f]{16,}$/i.test(t)) return false;
          return t.split(/[-.]/).every(function (x) { return x.length <= 15; });
        }
      };
      OLD.secretish = function (t) { return OLD.looksSecret(t) && !OLD.looksLikeSlug(t); };

      const UUIDISH = ["3f2504e0-4f89-11d3-9a0c-0305e82c3301",   /* UUID */
        "deadbeef-cafebabe-0123456789abcdef",                     /* 分段 hex */
        "abcdef0123.4567890abc.def012345678"];                    /* 點分段 hex */
      const B64ISH = ["hQ2r+Zx8Kd9vP0aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT=",  /* dk 型（44 碼標準 base64） */
        "Wm9uZ2d1by9CZW5zb24rS2V5cmluZ0tleTEyMzQ1Njc="];               /* vault 金鑰型 */
      const SAFE = ["brain-boosting-games", "travel-book", "lose-weight-helper",
        "xd1104.github.io", "beef-cafe", "movie-library"];

      function caughtInFile(v) {           /* 端到端：真的塞進會進 apps.json 的欄位 */
        const mm = clone(doc);
        mm.apps[0].name = v;
        const byScan = scanSecrets(mm).bad.length > 0;
        let byBuilder = false;             /* 產生器自己也要擋（整份產生失敗，不是靜靜拿掉） */
        try { KF.appsJsonText({ apps: [{ id: "x", name: v, emoji: "📦", url: "", token: "" }], generatedAt: "2026-01-01T00:00:00.000Z" }); }
        catch (e) { byBuilder = true; }
        return byScan && byBuilder;
      }
      const d6 = UUIDISH.every(caughtInFile);
      /* ⚠️ 負控組要挑**真的示範那個洞**的值：deadbeef-… 那個有一段 16 碼，
       *    補丁前就被「每段 ≤15」擋下了，拿它當負控組會誤以為尺是死的。
       *    UUID 與點分段 hex 才是補丁前確實會放行的那兩種。 */
      const d6old = UUIDISH.slice(0, 1).concat(UUIDISH.slice(2)).every(function (v) { return !OLD.secretish(v); });
      check("D6. ★ UUID／分段 hex 塞進 name → 掃描器與產生器都擋得下來", d6 && d6old,
        "現在擋得下：" + d6 + " / 負控組（補丁前的規則全部放行，證明這一條是承重的）：" + d6old);
      const d7 = B64ISH.every(caughtInFile);
      const d7old = B64ISH.every(function (v) { return !OLD.secretish(v); });
      check("D7. ★ 標準 base64（dk／vault 金鑰那一型）塞進 name → 一樣擋得下來", d7 && d7old,
        "現在擋得下：" + d7 + " / 負控組（補丁前的規則全部放行）：" + d7old);
      const d8 = SAFE.every(function (v) { return !KF.secretish(v); });
      check("D8. 反向對照：正常的 App 代號沒有被誤擋（不然這兩條就是在製造假警報）", d8,
        SAFE.map(function (v) { return v + (KF.secretish(v) ? "→擋" : "→過"); }).join(" "));

      /* ── D9／D10：2026-08-28 QA R-2 退件補的兩條 ────────────────────────────
       * 洞在 looksSecret() 的第一行「有空白＝是句子不是金鑰」：那只對「整格剛好等於一把
       * 金鑰」成立。**貼上時前後帶了字**才是最自然的貼法，而舊規則整串放行，
       * 那串會原樣被 push 到公開的 apps.json（QA 用真的 TMDB 值端到端證明過）。
       * 多欄位的整串 {"tmdb":…} 是同一個洞（引號括號讓整串不像金鑰）。
       * 負控組＝**現行規則的前一版 secretish()**：它必須放行這些值，才證明 secretishDeep()
       * 是承重的；有人把 appsBlockReason 改回 secretish，這兩條就會紅。 */
      const SENTENCE = [
        "電影 0a1b2c3d4e5f60718293a4b5c6d7e8f9",                          /* 句子＋hex */
        "我的金鑰是 hQ2r+Zx8Kd9vP0aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT= 別外流",  /* 句子＋標準 base64 */
        "token: github_pat_11FAKEFAKE0FAKEfakeFAKEfake1234567890",        /* 前綴＋PAT */
        "電影櫃 3f2504e0-4f89-11d3-9a0c-0305e82c3301 這把",                /* 句子＋UUID */
        "https://x.example/?token=github_pat_11FAKEFAKE0FAKEfakeFAKEfake1234", /* 網址的 query 夾 PAT */
        "vaultkey=hQ2r+Zx8Kd9vP0aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT="            /* key=value 夾 base64 */
      ];
      const BLOB = [
        JSON.stringify({ tmdb: "0a1b2c3d4e5f60718293a4b5c6d7e8f9", omdb: "0a1b2c3d" }),
        JSON.stringify({ key: "hQ2r+Zx8Kd9vP0aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT=" })
      ];
      /* 端到端＋「產出裡真的找不到那串」（JSON 跳脫會讓字面比對失準，所以連跳脫後的樣子一起找） */
      function blockedAndAbsent(v) {
        const mm = clone(doc);
        mm.apps[0].name = v;
        const byScan = scanSecrets(mm).bad.length > 0;
        let byBuilder = false, out = "";
        try { out = KF.appsJsonText({ apps: [{ id: "x", name: v, emoji: "📦", url: "", token: "" }], generatedAt: "2026-01-01T00:00:00.000Z" }); }
        catch (e) { byBuilder = true; }
        const escaped = JSON.stringify(v).slice(1, -1);
        const absent = byBuilder || (out.indexOf(v) < 0 && out.indexOf(escaped) < 0);
        return byScan && byBuilder && absent;
      }
      const d9 = SENTENCE.every(blockedAndAbsent);
      const d9old = SENTENCE.every(function (v) { return !KF.secretish(v); });
      check("D9. ★ 金鑰夾在句子裡（前後帶字）→ 掃描器與產生器都擋得下來，產出裡也找不到那串",
        d9 && d9old, "現在擋得下：" + d9 + " / 負控組（前一版 secretish 全部放行）：" + d9old);
      const d10 = BLOB.every(blockedAndAbsent);
      const d10old = BLOB.every(function (v) { return !KF.secretish(v); });
      check("D10. ★ 多欄位整串 {\"tmdb\":…} 貼進 name → 一樣擋得下來", d10 && d10old,
        "現在擋得下：" + d10 + " / 負控組（前一版 secretish 全部放行）：" + d10old);
      const SAFE2 = ["我的 App（2026 版）", "旅途手帳 v2.1", "Movie Library", "交易日誌 - 測試用",
        "https://xd1104.github.io/travel-book/"];
      const d11 = SAFE2.every(function (v) { return !KF.secretishDeep(v); });
      check("D11. 反向對照：帶空白／版本號／中文括號的正常名字沒有被誤擋", d11,
        SAFE2.map(function (v) { return v + (KF.secretishDeep(v) ? "→擋" : "→過"); }).join("　"));
      if (!(d9 && d9old && d10 && d10old && d11)) ruler("D9／D10 的負控組沒過 —— 句子裡夾金鑰那條紅線不可信");

      if (!(d6 && d6old && d7 && d7old && d8)) ruler("D6／D7 的負控組沒過 —— 那兩個洞的紅線不可信");

      if (!(d1 && d2 && d3 && d3b && d4 && d5)) ruler("D 負控組沒有全部翻紅 —— 尺壞了，上面的綠燈不算數");
    }
  }

  /* ---------------- S 測試檔裡不准有真值 ---------------- */
  if (wants("S")) {
    head("S  測試檔／原始碼裡不准出現真金鑰的片段（2026-08-28 QA S-1）");
    const tokens = localTokens();
    if (!tokens) {
      console.log("  ⚠️ 這台機器沒有 secrets.json —— **這一段沒測到**（不是通過）。");
    } else if (!tokens.length) {
      console.log("  ⚠️ secrets.json 裡一把金鑰都沒有 —— 這一段沒測到。");
    } else {
      /* ⚠️ 公開前綴（github_pat_／ghp_…）本來就到處都是，不是祕密片段；
       *    真正該掃的是前綴後面那一段。不先剝掉的話整個 repo 都會誤報。 */
      const secretParts = tokens.map(function (t) { return String(t).replace(/^(github_pat_|gh[porsu]_)/, ""); })
        .filter(function (t) { return t.length >= 12; });
      const files = [];
      (function walk(d) {
        fs.readdirSync(d, { withFileTypes: true }).forEach(function (f) {
          if (/^(.git|.venv|node_modules|__pycache__)$/.test(f.name)) return;
          const fp = path.join(d, f.name);
          if (f.isDirectory()) return walk(fp);
          /* secrets.json／vault.key 本來就是明文金鑰的家；vault.json／keyring.json 是產物
           * （keyring.json 的公開模式本來就會有明文值，那是 H 組在管的事，不是這一條） */
          if (/^(secrets.json|vault.key|vault.json|keyring.json)$/.test(f.name)) return;
          if (/.(js|md|html|css|json|py|pyw|bat|txt|yml|yaml)$/.test(f.name)) files.push(fp);
        });
      })(ROOT);
      const hits = [];
      files.forEach(function (fp) {
        let txt = "";
        try { txt = fs.readFileSync(fp, "utf8"); } catch (e) { return; }
        secretParts.forEach(function (v) {
          for (let k = 0; k + 12 <= v.length; k++) {
            if (txt.indexOf(v.slice(k, k + 12)) >= 0) {
              hits.push(path.relative(ROOT, fp));
              return;
            }
          }
        });
      });
      check("S1. ★ 掃了 " + files.length + " 個檔，沒有任何一個含真金鑰的 12 字片段",
        hits.length === 0, [...new Set(hits)].join("、"));
      /* 負控組：把真值的一段寫進一個暫存檔，這把尺必須抓得到 */
      const probe = path.join(ROOT, "tools", "__tmp__sniff.txt");
      let caught = false;
      try {
        fs.writeFileSync(probe, "測試用：" + secretParts[0].slice(3, 15) + "\n");
        const txt = fs.readFileSync(probe, "utf8");
        for (let k = 0; k + 12 <= secretParts[0].length; k++) {
          if (txt.indexOf(secretParts[0].slice(k, k + 12)) >= 0) { caught = true; break; }
        }
      } finally { try { fs.unlinkSync(probe); } catch (e) {} }
      check("S2. ★ 負控組：真的有片段時這把尺抓得到（而且測完就把暫存檔刪了）", caught);
      if (!caught) ruler("S2 負控組沒中 —— S1 的綠燈不算數");
    }
  }


  /* ---------------- E 兩端一致 ---------------- */
  if (wants("E")) {
    return groupE().then(finish);
  }
  return finish();
}

/* ------------------------------------------------------------------ */
/* E. 兩端產出逐位元組相同（電腦端 server.js vs 手機端 web/admin.js）     */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kr-public-"));
  for (const d of ["client", "public", "web"]) {
    fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  return dir;
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: "127.0.0.1", port, method, path: "/api" + p,
      headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} },
      (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch (e) { } resolve({ status: res.statusCode, body: j, raw: s }); });
      });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
async function waitUp(port) {
  for (let i = 0; i < 70; i++) {
    try { const r = await req(port, "GET", "/state"); if (r.body && r.body.ok) return true; } catch (e) { }
    await sleep(120);
  }
  return false;
}
/* 手機後台是**另一套實作**（直接寫 vault，不走 server）。這裡用跟 check-fields 同一招：
 * 在 vm 裡載入 web/admin.js，呼叫它自己的產生函式。 */
function loadWebAdmin() {
  const vm = require("vm");
  const src = fs.readFileSync(path.join(ROOT, "web", "admin.js"), "utf8");
  const noop = () => { };
  const el = () => ({ value: "", checked: false, textContent: "", className: "", hidden: true,
    innerHTML: "", style: {}, focus: noop, onclick: null, onchange: null, oninput: null,
    querySelectorAll: () => [], querySelector: () => null, appendChild: noop, addEventListener: noop });
  const ctx = {
    document: { getElementById: () => el(), createElement: el, addEventListener: noop,
      querySelectorAll: () => [], querySelector: () => null, body: el(), head: el() },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { hash: "", pathname: "/", search: "", href: "http://localhost/" },
    history: { replaceState: noop },
    navigator: { onLine: true },
    fetch: () => new Promise(() => { }),
    setTimeout: noop, clearTimeout: noop, console,
    crypto: { getRandomValues: (a) => a, subtle: {} },
    KeyringFields: KF, TextEncoder, TextDecoder, atob: () => "", btoa: () => ""
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "web/admin.js" });
  return ctx;
}

const FAKE_SECRETS = {
  version: 1, updatedAt: "2026-08-28T00:00:00.000Z",
  apps: [
    { id: "travel-book", name: "旅途手帳", emoji: "🧳", url: "https://xd1104.github.io/travel-book/",
      token: "github_pat_FAKE_travel_0001", fields: [], public: false, order: 1,
      keyExp: { expiresAt: "2026-12-02", source: "auto", checkedAt: "2026-08-28T07:41:58.000Z", state: "ok" } },
    { id: "recipe-book", name: "食譜本", emoji: "🍳", url: "https://xd1104.github.io/benson-receipe/",
      token: "github_pat_FAKE_recipe_0002", fields: [], public: false, order: 0,
      keyExp: { expiresAt: "2026-09-05", source: "manual", checkedAt: "2026-08-28T07:41:58.000Z", state: "ok" } },
    { id: "puzzle", name: "拼圖", emoji: "🧩", url: "https://xd1104.github.io/brain-boosting-games/",
      token: "", fields: [], public: false, repo: "xd1104/brain-boosting-games" }
  ],
  users: [], github: { token: "" }
};

async function groupE() {
  head("E  兩端產出逐位元組相同（電腦端 server.js ／ 手機端 web/admin.js）");
  const dir = makeSandbox();
  const port = 45291;
  fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(FAKE_SECRETS, null, 2));
  const ps = spawn(process.execPath, [path.join(dir, "server.js")], {
    cwd: dir, env: Object.assign({}, process.env, { PORT: String(port) }), stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  ps.stdout.on("data", (b) => logs.push(String(b)));
  ps.stderr.on("data", (b) => logs.push(String(b)));
  try {
    if (!(await waitUp(port))) { check("E0. sandbox server 起得來", false, logs.join("").slice(0, 300)); return; }
    /* 觸發一次寫入 → server 產出 apps.json（publish 會因為不是 git repo 而失敗，那是預期的） */
    const r = await req(port, "POST", "/apps/travel-book/users", { userIds: [] });
    if (!r.body || !r.body.ok) { check("E0. sandbox 寫得進去", false, r.raw.slice(0, 200)); return; }
    const serverText = fs.readFileSync(path.join(dir, "apps.json"), "utf8");
    const serverDoc = JSON.parse(serverText);

    const w = loadWebAdmin();
    if (typeof w.appsFileText !== "function") {
      check("E1. web/admin.js 有 appsFileText()（手機端也產同一份）", false,
        "手機端沒有這支函式 —— 那就等於只有電腦端會產 apps.json");
      ruler("E1 手機端沒有產生函式");
      return;
    }
    const webText = w.appsFileText({ apps: FAKE_SECRETS.apps }, serverDoc.generatedAt);
    check("E1. ★ 同一份輸入，兩端產出**逐位元組相同**", webText === serverText,
      webText === serverText ? "" :
        "電腦端 " + serverText.length + " bytes / 手機端 " + webText.length + " bytes\n      " +
        firstDiff(serverText, webText));

    /* 負控組：比較本身要是活的 —— 換一個 order 就必須比出不一樣 */
    const shuffled = JSON.parse(JSON.stringify(FAKE_SECRETS.apps));
    shuffled[0].order = 99;
    const webText2 = w.appsFileText({ apps: shuffled }, serverDoc.generatedAt);
    check("E2. ★ 負控組：輸入不一樣時真的比得出來（證明 E1 不是恆綠）", webText2 !== serverText);
    if (webText2 === serverText) ruler("E2 比較器是死的");

    /* 手機端產出的東西也要過白名單與掃描（它是另一套實作） */
    const wl = checkWhitelist(JSON.parse(webText));
    check("E3. 手機端的產出一樣過白名單", wl.length === 0, wl.slice(0, 4).join("\n      "));
    /* 產生器的守門：名字裡有金鑰就整份產不出來（不靜靜降級） */
    let threw = "";
    try {
      w.appsFileText({ apps: [{ id: "x", name: FAKE_PAT, emoji: "📦", url: "", token: "" }] }, "2026-01-01T00:00:00.000Z");
    } catch (e) { threw = String(e && e.message); }
    check("E4. ★ 名字裡是金鑰 → 整份產生失敗（不是靜靜拿掉那一欄）", !!threw, threw.slice(0, 60));
  } finally {
    try { ps.kill(); } catch (e) { }
    await sleep(150);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
}
function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return "第 " + i + " 個位元組起不同：\n      電腦端 …" + a.slice(Math.max(0, i - 20), i + 30) +
      "\n      手機端 …" + b.slice(Math.max(0, i - 20), i + 30);
  }
  return "";
}

/* ------------------------------------------------------------------ */
function finish() {
  const bad = results.filter((r) => !r.ok);
  console.log("\n────────────────────────────");
  console.log(bad.length ? "❌ " + bad.length + " / " + results.length + " 條沒過"
    : "✅ 全部 " + results.length + " 條都過");
  if (brokenRuler) {
    console.log("⚠️ 尺壞了：" + brokenRuler);
    console.log("   「掃了沒抓到」在這種情況下不代表乾淨，先修這支檢查本身。");
    process.exit(2);
  }
  process.exit(bad.length ? 1 : 0);
}

Promise.resolve().then(main).catch((e) => {
  console.error("檢查本身爆掉了：" + (e && e.stack || e));
  process.exit(2);
});
