"use strict";
/*
 * check-splash.js — 開場外觀（splash）的機器驗收（零依賴，只用 node 內建）
 *
 *   node tools/check-splash.js             全部
 *   node tools/check-splash.js --only=A,C  只跑某幾組
 *
 * 這支管的是「後台能不能改每個 App 的開場畫面」那一塊：
 *   A. 共用邏輯（client/keyring-fields.js 的 normSplash／normGlyph／adoptSplash…）
 *   B. 向後相容：**沒有 splash 的舊資料**，產出的 keyring.json 跟改動前的 server.js 逐項相同
 *   C. 本機後台 API 端到端：真的起一個 server.js（暫存資料夾、假金鑰）走完整存檔流程
 *      —— 含「空值不寫進 JSON」與「舊版前端存檔不會把 splash 洗掉」
 *   D. 同一條規則活在兩套實作裡（電腦後台 server.js／手機後台 web/admin.js）都要有
 *
 * ⚠️ 全程用**假金鑰**（ghp_FAKE_…／TMDBFAKEKEY_…），而且只在 os.tmpdir() 底下讀寫；
 *    永遠不碰 repo 裡的 keyring.json／vault.json／secrets.json／vault.key。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const KF = require(path.join(ROOT, "client", "keyring-fields.js"));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? "  ✅ " : "  ❌ ") + name + (detail ? "\n      " + detail : ""));
}
/* 「沒能測」跟「沒過」是兩回事：缺 Chrome 不該被講成通過，也不該被講成壞掉 */
const skipped = [];
function skip(name, why) {
  skipped.push(name);
  console.log("  ⏭ 未能測：" + name + (why ? "\n      " + why : ""));
}
function head(t) { console.log("\n" + t); }
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").replace("--only=", "");
const wants = (g) => !ONLY || ONLY.split(",").indexOf(g) >= 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/* ⚠️ 守門訊息是丟進 toast 的**純文字**：markdown 會原樣顯示成星號。
 * 手冊記過一次、這個 repo 踩過兩次，所以做成一條會紅的線，擋下一個「順手排版」的人。
 * （PUBLIC_WARNING 不在此列——那一句是當 HTML 渲染的，兩個後台都會把 ** 轉成 <b>。） */
const MD_MARKS = [["粗體 **", /\*\*/], ["底線 __", /__/], ["反引號", /`/], ["連結 []()", /\[[^\]]*\]\(/]];
const mdHits = (t) => MD_MARKS.filter((m) => m[1].test(String(t || ""))).map((m) => m[0]);

/* 跟 server.js 同一套加密參數（這支不動加密，只是為了把密文解回來比對明文有沒有被動到） */
const KDF = { iter: 600000, hash: "sha256", keyLen: 32 };
function decryptWithKey(keyBuf, ivB64, cipherB64) {
  const raw = Buffer.from(cipherB64, "base64");
  const tag = raw.subarray(raw.length - 16), body = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", keyBuf, Buffer.from(ivB64, "base64"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}
function decryptRing(ring, dk) {
  const out = {};
  const u = ring.users[0];
  Object.keys(u.apps).forEach((id) => {
    out[id] = decryptWithKey(Buffer.from(dk, "base64"), u.apps[id].iv, u.apps[id].cipher);
  });
  return out;
}

const FAKE = {
  travel: "ghp_FAKE_travel_0001",
  recipe: "ghp_FAKE_recipe_0002",
  tmdb: "TMDBFAKEKEY_AAAA_1111_2222_3333",
};
function fakeSecrets() {
  const salt = crypto.randomBytes(16).toString("base64");
  const dk = crypto.pbkdf2Sync(Buffer.from("pw-fake", "utf8"), Buffer.from(salt, "base64"),
    KDF.iter, KDF.keyLen, KDF.hash).toString("base64");
  const apps = [
    { id: "travel-book", name: "旅途手帳", emoji: "🧳", url: "", token: FAKE.travel },
    { id: "recipe-book", name: "食譜本", emoji: "🍳", url: "", token: FAKE.recipe },
    { id: "movie-library", name: "好雷嗎", emoji: "📓", url: "", token: FAKE.tmdb, public: true },
  ];
  return {
    version: 1, updatedAt: "2026-08-25T00:00:00.000Z",
    apps,
    users: [{ id: "u-fake", name: "測試", emoji: "🧔", theme: "ocean", salt, dk, apps: apps.map((a) => a.id) }],
    github: { token: "" },
  };
}

/* 把 repo 複製到暫存資料夾（不含任何真實資料檔），可指定用改動前的 server.js */
function makeSandbox(label, oldServer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kr-splash-" + label + "-"));
  for (const d of ["client", "public", "web"]) {
    fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  }
  if (oldServer) {
    fs.writeFileSync(path.join(dir, "server.js"),
      execFileSync("git", ["show", "main:server.js"], { cwd: ROOT, maxBuffer: 8e6 }));
  } else {
    fs.copyFileSync(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  }
  return dir;
}
function startServer(dir, port) {
  const ps = spawn(process.execPath, [path.join(dir, "server.js")], {
    cwd: dir, env: Object.assign({}, process.env, { PORT: String(port) }), stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  ps.stdout.on("data", (b) => logs.push(String(b)));
  ps.stderr.on("data", (b) => logs.push(String(b)));
  return { ps, logs };
}
const RECORD = [];   /* 每一次 HTTP 回應的原文（紅線：回應裡不准出現明文金鑰） */
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: "127.0.0.1", port, method, path: "/api" + p,
      headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} },
      (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => {
          let j = null;
          try { j = JSON.parse(s); } catch (e) { }
          RECORD.push({ method, path: p, status: res.statusCode, raw: s });
          resolve({ status: res.statusCode, body: j, raw: s });
        });
      });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 8000)) {
    try { const r = await req(port, "GET", "/state"); if (r.body && r.body.ok) return true; } catch (e) { }
    await sleep(120);
  }
  return false;
}
const ringOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "keyring.json"), "utf8"));
const appIn = (ring, id) => ring.apps.find((a) => a.id === id);
/* 比對「除了某個 App 的 splash 以外，公開檔一個位元組都沒變」用的正規化：
 * users 的密文每次重產都會換 iv（那是加密該有的行為），所以比對的是**解出來的明文**。 */
function ringShape(ring, dk) {
  return {
    apps: ring.apps.map((a) => Object.assign({}, a, { splash: undefined })),
    users: ring.users.map((u) => ({ id: u.id, name: u.name, emoji: u.emoji, theme: u.theme, kdf: u.kdf,
      apps: Object.keys(u.apps).sort() })),
    plain: decryptRing(ring, dk),
  };
}

/* ------------------------------------------------------------------ */
/* A. 共用邏輯                                                          */
/* ------------------------------------------------------------------ */
function groupA() {
  head("A  共用邏輯（client/keyring-fields.js）");

  check("A1. 沒設定／壞資料一律回 null（不是空物件）",
    KF.normSplash(undefined) === null && KF.normSplash(null) === null && KF.normSplash("x") === null &&
    KF.normSplash([]) === null && KF.normSplash({}) === null && KF.normSplash({ zz: 1 }) === null,
    JSON.stringify(KF.normSplash({ zz: 1 })));

  check("A2. ★ 空值一律不寫進去（空字串、只有空白、看不懂的色票都當沒設）",
    eq(KF.normSplash({ name: "", glyph: "  ", bg: "", accent: "藍色", ink: "#12345", tagline: "" }), null) &&
    eq(KF.normSplash({ name: " 交易日誌 ", tagline: "" }), { name: "交易日誌" }),
    JSON.stringify(KF.normSplash({ name: " 交易日誌 ", accent: "藍色", tagline: "" })));

  check("A3. 認得的鍵才留，順序固定，其他鍵丟掉",
    eq(KF.normSplash({ tagline: "紀律比行情重要", glyph: "T", bg: "#101820", 惡意: "x" }),
      { glyph: "T", bg: "#101820", tagline: "紀律比行情重要" }),
    JSON.stringify(KF.normSplash({ tagline: "紀律比行情重要", glyph: "T", bg: "#101820", 惡意: "x" })));

  check("A4. 色票正規化：#RGB → #rrggbb 小寫；不合法就當沒設",
    KF.normColor("#ABC") === "#aabbcc" && KF.normColor("#3A7BD5") === "#3a7bd5" &&
    KF.normColor("rgb(1,2,3)") === "" && KF.normColor("#12345") === "" && KF.normColor("") === "",
    [KF.normColor("#ABC"), KF.normColor("#3A7BD5"), JSON.stringify(KF.normColor("#12345"))].join(" / "));

  check("A5. ★ 符號只留一個字元（中文、英文、emoji、含膚色與 ZWJ 的組合字都算一個）",
    KF.normGlyph("ABC") === "A" && KF.normGlyph("交易日誌") === "交" &&
    KF.normGlyph("❤️x") === "❤️" && KF.normGlyph("👨‍👩‍👧") === "👨‍👩‍👧" &&
    KF.normGlyph("👍🏽!") === "👍🏽" && KF.normGlyph("  ") === "" &&
    KF.normGlyph("🇹🇼") === "🇹🇼" && KF.normGlyph("🇹🇼🇯🇵") === "🇹🇼",   /* 國旗是兩個碼位湊的，切一半會變成 🇹 */
    [KF.normGlyph("ABC"), KF.normGlyph("❤️x"), KF.normGlyph("👨‍👩‍👧"), KF.normGlyph("👍🏽!"), KF.normGlyph("🇹🇼")].join(" / "));

  /* ⚠️ 上限是「看得見幾個字」，所以要按**字素**切。用 slice(0,n) 切 UTF-16 碼元會在尾端
   *    留下半個代理對，而這串字是要寫進公開 keyring.json 的 —— App 端會顯示成一個 �。 */
  const hasOrphan = (t) => /[�-�](?![�-�])|(^|[^�-�])[�-�]/.test(t);
  const longName = KF.normSplash({ name: "🇹🇼🎉".repeat(20) }).name;
  const longTag = KF.normSplash({ tagline: "🎉".repeat(60) }).tagline;
  check("A6. ★ 名字／標語有長度上限，而且是按字素切（不會留下半個 emoji）",
    KF.normSplash({ name: "字".repeat(50) }).name.length === KF.SPLASH_MAX.name &&
    Array.from(longName).length > 0 && !hasOrphan(longName) && !hasOrphan(longTag) &&
    Array.from(longTag).length === KF.SPLASH_MAX.tagline &&
    longTag.length === KF.SPLASH_MAX.tagline * 2,   /* 🎉 是一個字素、兩個碼元 */
    "上限 " + KF.SPLASH_MAX.name + "／" + KF.SPLASH_MAX.tagline + " 個字；尾端有半個 emoji？" +
    (hasOrphan(longName) || hasOrphan(longTag) ? "有" : "沒有"));

  /* ⭐ 這條就是 DESIGN.md 那個坑：舊版後台送上來的資料**沒有這個鍵**＝「這版不認得」，
   *    不是「他要清掉」。真的要清掉會送 splash:null（有鍵、值是 null）。 */
  const prev = { splash: { glyph: "T", bg: "#101820" } };
  check("A7. ★ 舊版沒帶 splash 這個鍵 → 保留原本的（不是被洗掉）",
    eq(KF.adoptSplash({ id: "x" }, prev), { glyph: "T", bg: "#101820" }) &&
    eq(KF.adoptSplash({ id: "x", name: "改個名字" }, prev), { glyph: "T", bg: "#101820" }),
    JSON.stringify(KF.adoptSplash({ id: "x" }, prev)));
  check("A8. 新版明確送 splash:null／空物件 → 真的清掉",
    KF.adoptSplash({ id: "x", splash: null }, prev) === null &&
    KF.adoptSplash({ id: "x", splash: {} }, prev) === null &&
    eq(KF.adoptSplash({ id: "x", splash: { glyph: "K" } }, prev), { glyph: "K" }));

  check("A9. 預覽用的補值不會污染存檔（splashView 只給畫面看）",
    eq(KF.splashView({ name: "交易日誌" }),
      { name: "交易日誌", glyph: "交", bg: KF.SPLASH_DEFAULTS.bg, accent: KF.SPLASH_DEFAULTS.accent,
        ink: KF.SPLASH_DEFAULTS.ink, tagline: "" }) &&
    KF.normSplash({ name: "交易日誌" }).bg === undefined,
    JSON.stringify(KF.splashView({ name: "交易日誌" })));

  /* ⭐ 守門用的是專案既有的 looksSecret()，不是另外寫一套「像不像 GitHub token」——
   *    只擋 GitHub 的話，TMDB 32 碼十六進位、sk-proj-…、AIzaSy… 全部照過，
   *    而 splash 是自由文字又是公開明文，這個 repo 已經有兩次「金鑰被貼進自由文字欄」的前科。 */
  const secrets = ["ghp_" + "a".repeat(30), "github_pat_" + "b".repeat(22),
    "0a1b2c3d4e5f60718293a4b5c6d7e8f9"   /* 合成值，不是真金鑰 */, "sk-proj-abcdefghijklmnopqrst", "AIzaSyA1B2C3D4E5F6G7H8I9J0"];
  const fine = ["紀律比行情重要", "交易日誌", "吃什麼都好", "Trade with discipline"];
  check("A10. ★ 開場外觀是公開明文 → 看起來像金鑰的一律擋（TMDB／OpenAI／Google 的也算）",
    secrets.every((t) => !!KF.splashBlockReason({ tagline: t })) &&
    fine.every((t) => KF.splashBlockReason({ tagline: t }) === ""),
    secrets.map((t) => t.slice(0, 10) + "→擋").join(" ") + "；正常標語 " + fine.length + " 句都放行");

  /* ⭐ 符號字色不是設定項（PM 2026-08-25 拍板，QA R-1 退件後改用 WCAG 對比度）。
   * ⚠️ 下面量對比度用的是**這支檔案自己寫的一份**，不是 KF 匯出的那份 —— 尺不可以跟被量的東西
   *    是同一段程式，否則把 relLum 的 gamma 改壞時，選色與量測會一起壞掉、測試照樣全綠。 */
  const REF = {
    lum(hex) {
      let h = String(hex || "").replace("#", "");
      if (h.length === 4 || h.length === 8) h = h.slice(0, h.length === 4 ? 3 : 6);   /* 丟掉 alpha（4 碼留 3、8 碼留 6） */
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      if (!/^[0-9a-fA-F]{6}$/.test(h)) return 0;
      const c = [0, 2, 4].map((i) => {
        const v = parseInt(h.substr(i, 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    },
    ratio(a, b) {
      const la = REF.lum(a), lb = REF.lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    },
  };
  const r3 = (bg) => REF.ratio(KF.onColor(bg), bg);

  /* ⭐ 出路要講在前面：他是在被擋下來、正在困惑的當下讀這句話。 */
  const blocked = KF.splashBlockReason({ tagline: "0a1b2c3d4e5f60718293a4b5c6d7e8f9" });
  check("A10b. ★ 守門訊息是純文字（沒有 markdown），而且開頭就告訴他怎麼過關",
    mdHits(blocked).length === 0 && /^「標語」/.test(blocked) &&
    blocked.indexOf("空格") < blocked.indexOf("像一把金鑰"),
    (mdHits(blocked).join("、") || "沒有 markdown 標記") + "｜" + blocked.slice(0, 34) + "…");

  check("A11. ★ 符號字色由 accent 自動推導（白字／深字取對比高的那個）",
    KF.onColor("#ffcc00") === "#1a1310" && KF.onColor("#fff") === "#1a1310" &&
    KF.onColor("#101820") === "#ffffff" && KF.onColor("#000") === "#ffffff" &&
    KF.onColor("") === "#ffffff" && KF.onColor("藍色") === "#ffffff" &&
    /* ⭐ 平手偏白（差距 <15%）：預設 accent #3a7bd5 是白 4.22 / 深 4.35，差 2.9%——
     *    兩個都夠讀，但深字會讓符號從「發光的徽章」變成「挖空的洞」，
     *    跟開場其餘的淺色字分屬兩套語言。所以近乎平手時給白字。 */
    KF.onColor("#3a7bd5") === "#ffffff",
    ["#ffcc00→" + KF.onColor("#ffcc00"), "#101820→" + KF.onColor("#101820"),
      "#3a7bd5→" + KF.onColor("#3a7bd5") + "（平手偏白）"].join(" / "));

  /* QA 掃到的三個點：舊的「亮度 > 0.6」把飽和綠／青當成暗底 → 給白字 → 最差 2.08:1 */
  const spots = ["#00d038", "#1db954", "#00bcd4"];
  check("A12. ★ QA 抓到的三個飽和綠／青：必須給深字，而且對比 ≥ 3:1",
    spots.every((c) => KF.onColor(c) === "#1a1310" && r3(c) >= 3),
    spots.map((c) => c + "→" + KF.onColor(c) + " " + r3(c).toFixed(2) + ":1").join("  "));

  /* 全色域紅線：這條才是「不可能被調成看不見」的證明（gamma 被改壞就會翻紅） */
  let worst = { bg: "", ratio: 99 }, below = 0, total = 0;
  for (let r = 0; r < 256; r += 8) for (let g = 0; g < 256; g += 8) for (let b = 0; b < 256; b += 8) {
    const bg = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    const ratio = r3(bg);
    total++;
    if (ratio < 3) below++;
    if (ratio < worst.ratio) worst = { bg, ratio };
  }
  /* 這裡是 step 8 抽樣（32,768 色，跑得快）。窮舉 16,777,216 色的實測結果：
   * **低於 3:1 的 0 個、最差 #438c83 = 3.949:1（白字）** —— 抽樣量到的只會比它高，不會更低。
   * 3:1 是 WCAG 對「大字／圖形元件」那條線；符號是 31px 粗體，用這條是對的。
   * ⚠️ 3.949 這個下界是「平手偏白 15%」買來的（原本 4.283）。要動那個 15% 之前先跑這一條。 */
  check("A13. ★ 全色域掃描（" + total + " 個底色）：沒有任何一個低於 3:1",
    below === 0 && worst.ratio >= 3.9,
    "最差 " + worst.bg + " " + worst.ratio.toFixed(3) + ":1；低於 3:1 的有 " + below + " 個" +
    "（窮舉 16,777,216 色的實測最差是 #438c83 3.949:1）");

  /* ⭐ 帶 alpha 的色碼（QA 在 app-template 那端抓到的破口）：
   * 4／8 碼如果被當成「看不懂」→ 亮度算成 0＝純黑 → 永遠給白字 → #ffffffff 會變成白底白字 1.00:1。
   * 這條走**完整條路**：契約先擋（normColor／normSplash 不收），
   * 就算有人手改 keyring.json 硬塞進來，onColor 也要算得出安全的字色。 */
  const alphas = ["#ffffffff", "#fffe", "#f6f2e9ff"];
  check("A13b. ★ 帶 alpha 的色碼：契約擋在門口，硬塞進來也不會產生看不見的組合",
    alphas.every((c) => KF.normColor(c) === "" && !KF.normSplash({ accent: c })) &&
    alphas.every((c) => r3(c) >= 3),
    alphas.map((c) => c + "→契約丟掉、硬算 " + KF.onColor(c) + " " + r3(c).toFixed(2) + ":1").join("  "));

}

/* ------------------------------------------------------------------ */
/* B. 向後相容：沒有 splash 的舊資料，產物跟改動前一模一樣                 */
/* ------------------------------------------------------------------ */
async function groupB() {
  head("B  向後相容：沒有 splash 的舊 secrets.json，產物與改動前逐項相同");
  const secrets = fakeSecrets();
  const dirs = [], procs = [];
  try {
    const out = {};
    for (const [label, oldOne, port] of [["new", false, 45341], ["old", true, 45342]]) {
      const dir = makeSandbox(label, oldOne);
      dirs.push(dir);
      fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(secrets, null, 2));
      const s = startServer(dir, port);
      procs.push(s.ps);
      if (!(await waitUp(port))) {
        check("B0. " + label + " server 起得來", false, s.logs.join("").slice(0, 300));
        return;
      }
      /* 存一次（換金鑰）逼它重產 keyring.json，兩邊走的是同一條路 */
      await req(port, "POST", "/apps/travel-book/token", { token: FAKE.travel });
      out[label] = { ring: ringOf(dir), dir };
    }
    const a = ringShape(out.new.ring, secrets.users[0].dk);
    const b = ringShape(out.old.ring, secrets.users[0].dk);
    check("B1. ★ 公開檔的 apps[] 逐項相同（沒有 splash 的 App 不會長出這個鍵）",
      eq(a.apps, b.apps) && out.new.ring.apps.every((x) => !("splash" in x)),
      JSON.stringify(out.new.ring.apps));
    check("B2. ★ 使用者結構（id／salt／kdf／可用的 App）逐項相同", eq(a.users, b.users));
    check("B3. ★ 解出來的明文金鑰逐把相同（加密流程一個字都沒被動到）",
      eq(a.plain, b.plain), JSON.stringify(Object.keys(a.plain)));
    check("B4. 公開模式的 public／plain 照舊（同一層級的鄰居沒被波及）",
      appIn(out.new.ring, "movie-library").public === true &&
      appIn(out.new.ring, "movie-library").plain === FAKE.tmdb,
      JSON.stringify(appIn(out.new.ring, "movie-library")));
  } finally {
    procs.forEach((p) => { try { p.kill(); } catch (e) { } });
    await sleep(200);
    dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { } });
  }
}

/* ------------------------------------------------------------------ */
/* C. 端到端：真的起 server.js 走完整存檔流程                             */
/* ------------------------------------------------------------------ */
async function groupC() {
  head("C  本機後台 API：開場外觀的完整存檔流程（真的起 server.js，假金鑰）");
  const secrets = fakeSecrets();
  const dir = makeSandbox("api", false);
  fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(secrets, null, 2));
  const port = 45343;
  const s = startServer(dir, port);
  const dk = secrets.users[0].dk;
  const SP = { name: "交易日誌", glyph: "T", bg: "#101820", accent: "#3A7BD5", ink: "#e6edf3",
    tagline: "紀律比行情重要" };
  try {
    if (!(await waitUp(port))) { check("C0. server 起得來", false, s.logs.join("").slice(0, 300)); return; }
    /* keyring.json 是「存檔時才產生」的產物，先存一次拿到基準線（改動前的長相） */
    await req(port, "POST", "/apps/travel-book/token", { token: FAKE.travel });
    const before = ringShape(ringOf(dir), dk);

    let r = await req(port, "POST", "/apps/travel-book/splash", { splash: SP });
    let ring = ringOf(dir);
    check("C1. ★ 存進公開的 keyring.json，就在 apps[] 那一層（色票正規化成小寫）",
      r.status === 200 && eq(appIn(ring, "travel-book").splash,
        { name: "交易日誌", glyph: "T", bg: "#101820", accent: "#3a7bd5", ink: "#e6edf3", tagline: "紀律比行情重要" }),
      JSON.stringify(appIn(ring, "travel-book")));
    check("C2. ★ 除了那個 App 的 splash，公開檔其他東西一個位元組都沒變（含解出來的明文金鑰）",
      eq(ringShape(ring, dk), before), "");
    const sec = JSON.parse(fs.readFileSync(path.join(dir, "secrets.json"), "utf8"));
    check("C3. 也落地在 secrets.json（重開後台還在），而且其他 App 沒有長出 splash",
      eq(sec.apps.find((a) => a.id === "travel-book").splash, appIn(ring, "travel-book").splash) &&
      sec.apps.filter((a) => a.id !== "travel-book").every((a) => !("splash" in a)),
      JSON.stringify(sec.apps.map((a) => a.id + ":" + ("splash" in a))));
    check("C4. 後台畫面（/state）拿得到目前的設定", !!r.body.state.apps.find((a) => a.id === "travel-book").splash);

    /* 空值不寫進 JSON —— 這是硬條件：公開檔不要塞一堆空字串 */
    r = await req(port, "POST", "/apps/recipe-book/splash",
      { splash: { name: "", glyph: "  ", bg: "", accent: "", ink: "", tagline: "" } });
    ring = ringOf(dir);
    check("C5. ★ 全部留白 → keyring.json 裡連 splash 這個鍵都不會出現",
      r.status === 200 && !("splash" in appIn(ring, "recipe-book")),
      JSON.stringify(appIn(ring, "recipe-book")));
    r = await req(port, "POST", "/apps/recipe-book/splash", { splash: { glyph: "食", tagline: "" } });
    ring = ringOf(dir);
    check("C6. ★ 只設一項 → 只有那一個鍵（沒設的項目不會被塞預設值）",
      eq(appIn(ring, "recipe-book").splash, { glyph: "食" }),
      JSON.stringify(appIn(ring, "recipe-book").splash));

    /* ⭐ 「舊版前端存檔」：登記／改名那張表單根本沒有 splash 欄位，送上來的 body 也沒有這個鍵。
     *    這正是手機還快取著舊版 admin.js 時會發生的事 —— 不可以把 splash 洗掉。 */
    r = await req(port, "POST", "/apps", { id: "travel-book", name: "旅途手帳（改過名字）", emoji: "🧳" });
    ring = ringOf(dir);
    check("C7. ★ 舊版表單存檔（body 沒有 splash 這個鍵）→ splash 原封不動",
      appIn(ring, "travel-book").name === "旅途手帳（改過名字）" &&
      eq(appIn(ring, "travel-book").splash, {
        name: "交易日誌", glyph: "T", bg: "#101820", accent: "#3a7bd5", ink: "#e6edf3", tagline: "紀律比行情重要" }),
      JSON.stringify(appIn(ring, "travel-book").splash));
    await req(port, "POST", "/apps/travel-book/token", { token: FAKE.travel });
    await req(port, "POST", "/apps/travel-book/users", { userIds: ["u-fake"] });
    await req(port, "POST", "/apps/travel-book/fields", { fields: [] });
    ring = ringOf(dir);
    check("C8. ★ 換金鑰／改成員／改欄位之後 splash 還在（不是只有一條路要顧）",
      !!appIn(ring, "travel-book").splash, JSON.stringify(appIn(ring, "travel-book").splash));

    /* 清掉：明確送 null 才會清 */
    r = await req(port, "POST", "/apps/recipe-book/splash", { splash: null });
    ring = ringOf(dir);
    check("C9. 明確送 splash:null → 真的清掉（改回 App 自己的預設）",
      r.status === 200 && !("splash" in appIn(ring, "recipe-book")));

    /* 守門：開場外觀是公開明文 */
    r = await req(port, "POST", "/apps/recipe-book/splash",
      { splash: { tagline: "ghp_" + "a".repeat(30) } });
    ring = ringOf(dir);
    check("C10. ★ 標語裡放 GitHub token → 400 擋下來，而且沒有寫進公開檔",
      r.status === 400 && !("splash" in appIn(ring, "recipe-book")), r.body && r.body.message);
    check("C10b. ★ server 回的那句話也是純文字（第二條路，前端會原樣丟進 toast）",
      r.status === 400 && mdHits(r.body && r.body.message).length === 0,
      mdHits(r.body && r.body.message).join("、") || "沒有 markdown 標記");

    /* 找不到的 App */
    r = await req(port, "POST", "/apps/no-such-app/splash", { splash: { glyph: "X" } });
    check("C11. 不存在的 App 回 404 人話", r.status === 404, r.body && r.body.message);

    /* 舊資料：secrets.json 裡有 splash:{} / splash:null 這種殘骸，重開後台不會壞 */
    fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(Object.assign({}, sec, {
      apps: sec.apps.map((a) => Object.assign({}, a,
        a.id === "recipe-book" ? { splash: {} } : a.id === "travel-book" ? { splash: null } : {})),
    }), null, 2));
    s.ps.kill();
    await sleep(250);
    const s2 = startServer(dir, port + 1);
    try {
      if (!(await waitUp(port + 1))) {
        check("C12. 帶著 splash 殘骸的 secrets.json 還是起得來", false, s2.logs.join("").slice(0, 300));
      } else {
        const st = await req(port + 1, "GET", "/state");
        await req(port + 1, "POST", "/apps/recipe-book/token", { token: FAKE.recipe });
        ring = ringOf(dir);
        check("C12. ★ splash 是空物件／null 的舊資料 → 讀得起來，公開檔也不會出現空的 splash",
          st.status === 200 && st.body.state.apps.every((a) => a.splash === null) &&
          ring.apps.every((a) => !("splash" in a)),
          JSON.stringify(ring.apps));
      }
    } finally { try { s2.ps.kill(); } catch (e) { } }

    /* 紅線：這一輪所有 HTTP 回應的原文裡，不准出現任何一把明文金鑰（公開的那把除外） */
    const leaks = RECORD.filter((x) => x.raw.indexOf(FAKE.travel) >= 0 || x.raw.indexOf(FAKE.recipe) >= 0)
      .map((x) => x.method + " " + x.path);
    check("C13. ★ 新開的 /splash 端點（與整輪回應）都沒有吐出明文金鑰",
      leaks.length === 0, leaks.join("、") || "0 次命中");
  } finally {
    try { s.ps.kill(); } catch (e) { }
    await sleep(200);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
}

/* ------------------------------------------------------------------ */
/* D. 同一條規則活在兩套實作裡                                           */
/* ------------------------------------------------------------------ */
function groupD() {
  head("D  電腦後台與手機後台是兩套實作，兩邊都要有（只修一邊等於沒修）");
  const src = {};
  for (const rel of ["server.js", "web/admin.js", "public/admin.js"]) {
    src[rel] = fs.readFileSync(path.join(ROOT, rel), "utf8");
  }
  const code = (rel) => src[rel].split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

  check("D1. ★ 兩邊的 buildKeyring 都會把 splash 寫進公開檔",
    /\.splash\s*=\s*sp\b/.test(code("server.js")) && /\.splash\s*=\s*sp\b/.test(code("web/admin.js")),
    "server.js／web/admin.js");
  check("D2. ★ 兩邊都有讓他改開場外觀的入口",
    /openSplashForm/.test(code("public/admin.js")) && /appSplashSheet/.test(code("web/admin.js")));
  check("D3. ★ 接手別台的改動時用 adoptSplash（舊版沒帶這個鍵不算清空）",
    /KF\.adoptSplash\(/.test(code("server.js")));
  check("D4. 兩邊存檔前都會先 normSplash（空值不會被送出去）",
    /KF\.normSplash\(/.test(code("public/admin.js")) && /KF\.normSplash\(/.test(code("web/admin.js")));
  check("D5. 預覽的預設色只用在畫面上，沒有被寫進存檔路徑",
    !/splash\s*[:=]\s*KF\.splashView/.test(code("public/admin.js")) &&
    !/splash\s*[:=]\s*KF\.splashView/.test(code("web/admin.js")) &&
    !/SPLASH_DEFAULTS/.test(code("server.js")));
}

/* ------------------------------------------------------------------ */
/* E. 兩個後台的畫面（真的 headless Chrome，量 computed style）           */
/* ------------------------------------------------------------------ */
async function groupE() {
  head("E  後台畫面：即時預覽真的會動（headless Chrome，量 computed style）");
  let cdp;
  try { cdp = require("./cdp.js"); } catch (e) { skip("E. 載不到 tools/cdp.js", e.message); return; }
  const secrets = fakeSecrets();
  const dir = makeSandbox("ui", false);
  fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(secrets, null, 2));
  const port = 45345;
  const s = startServer(dir, port);
  let br = null;
  try {
    if (!(await waitUp(port))) { check("E0. server 起得來", false, s.logs.join("").slice(0, 300)); return; }
    try { br = await cdp.launch({ width: 1100, height: 900 }); } catch (e) {
      skip("E. 這台機器沒有 headless Chrome，畫面這一組沒測到", e.message); return;
    }
    const p = br.page;
    const base = "http://127.0.0.1:" + port;

    /* ---- 電腦後台 ---- */
    await p.goto(base + "/");
    let r = await p.eval(`
      await new Promise((res)=>setTimeout(res,600));
      openSplashForm("travel-book");
      const g = (id)=>document.getElementById(id);
      const before = getComputedStyle(g("sp-prev")).backgroundColor;
      /* 打字：名字、標語、符號（符號故意打三個字，UI 要當場擋成一個） */
      g("sp-name").value = "交易日誌"; g("sp-name").dispatchEvent(new Event("input"));
      g("sp-tag").value  = "紀律比行情重要"; g("sp-tag").dispatchEvent(new Event("input"));
      g("sp-glyph").value = "ABC"; g("sp-glyph").dispatchEvent(new Event("input"));
      /* 改顏色：底色與符號底色 */
      g("sp-bg").value = "#2b0b0b"; g("sp-bg").dispatchEvent(new Event("input"));
      g("sp-accent").value = "#ffcc00"; g("sp-accent").dispatchEvent(new Event("input"));
      /* ⚠️ 先等一下再量：縮圖有 .12s 的顏色轉場，**改完當下量到的還是舊顏色**
       *    （computed style 在轉場途中回的是當下的中間值）。不等就會得到「沒變」的假結論。 */
      await new Promise((res)=>setTimeout(res,300));
      return {
        before,
        glyphValue: g("sp-glyph").value,
        markText: g("sp-mark").textContent,
        nameText: g("sp-nm").textContent,
        tagText: g("sp-tg").textContent,
        prevBg: getComputedStyle(g("sp-prev")).backgroundColor,
        markBg: getComputedStyle(g("sp-mark")).backgroundColor,
        markInk: getComputedStyle(g("sp-mark")).color,
        inkSwatch: g("sp-ink").value,
        prevBox: g("sp-prev").getBoundingClientRect().height,
        clrShown: !g("sp-clr-bg").hidden && g("sp-clr-ink").hidden
      };
    `);
    check("E1. ★ 電腦後台：改顏色時縮圖真的跟著變（量 computed style，不是看程式碼）",
      r.before === "rgb(16, 24, 32)" && r.prevBg === "rgb(43, 11, 11)" && r.markBg === "rgb(255, 204, 0)",
      "底色 " + r.before + " → " + r.prevBg + "；符號底色 " + r.markBg);
    /* ⭐ 符號字色不是設定項：accent 是亮黃 #ffcc00 → 必須是深字，不能是白字（白字在黃底上看不見）。
     * 而且它跟「開場文字色」無關 —— 這裡刻意不去動 sp-ink，證明字色是從 accent 推出來的。 */
    check("E1b. ★ 亮色 accent 的符號自動變深字（不是白字、也不是跟著 ink 走）",
      r.markInk === "rgb(26, 19, 16)" && r.inkSwatch === KF.SPLASH_DEFAULTS.ink,
      "符號字色 " + r.markInk + "（accent=#ffcc00、開場文字色沒動過＝" + r.inkSwatch + "）");
    check("E2. ★ 電腦後台：符號打三個字，輸入框當場只留一個",
      r.glyphValue === "A" && r.markText === "A", "輸入框=" + r.glyphValue + " 縮圖=" + r.markText);
    check("E3. 電腦後台：名字／標語即時反映在縮圖上，縮圖有實際高度",
      r.nameText === "交易日誌" && r.tagText === "紀律比行情重要" && r.prevBox > 150,
      r.nameText + "／" + r.tagText + "／高 " + r.prevBox + "px");
    check("E4. 只有被改過的顏色會顯示「改回預設」（沒動過的還是沿用 App 預設）", r.clrShown === true);

    r = await p.eval(`
      document.querySelector(".dialog .btn-primary").click();
      await new Promise((res)=>setTimeout(res,900));
      const st = await (await fetch("/api/state")).json();
      const a = st.state.apps.find((x)=>x.id==="travel-book");
      setTab("apps");   /* 後台預設站在「使用者」那一頁，App 列表要切過去才在 DOM 裡 */
      return { splash: a.splash, dialogClosed: document.getElementById("sheet-layer").hidden,
        row: document.getElementById("admin").textContent.indexOf("開場外觀：符號 A") >= 0 };
    `);
    check("E5. ★ 電腦後台：按存起來 → 真的存進去，而且沒設的顏色不會被塞進去",
      eq(r.splash, { name: "交易日誌", glyph: "A", bg: "#2b0b0b", accent: "#ffcc00", tagline: "紀律比行情重要" }) &&
      r.dialogClosed === true,
      JSON.stringify(r.splash));
    check("E6. 電腦後台：列表那一行看得到目前的開場設定", r.row === true);
    const ring = ringOf(dir);
    check("E7. ★ 電腦後台存完，公開的 keyring.json 立刻就有（存檔即發布）",
      eq(appIn(ring, "travel-book").splash, r.splash), JSON.stringify(appIn(ring, "travel-book").splash));

    /* ---- 手機後台（純靜態，直接寫 vault；這裡把上傳那一段擋掉，只驗畫面與資料） ---- */
    await p.goto(base + "/web/");
    r = await p.eval(`
      await new Promise((res)=>setTimeout(res,500));
      /* 造一份假的「已解開的真本」：不碰 vault、不碰 GitHub、不碰任何真金鑰 */
      ST.P = { version:1, updatedAt:"", github:{token:""},
        apps:[{ id:"trade-log", name:"交易日誌", emoji:"📦", url:"", token:"", fields:[] }], users:[] };
      ST.keyBytes = new Uint8Array(32); ST.vaultSalt = "x";
      window.__saved = null;
      window.save = function(what){ window.__saved = what; return Promise.resolve(); };  /* 不上傳 */
      appSplashSheet(ST.P.apps[0]);
      const g = (id)=>document.getElementById(id);
      const before = getComputedStyle(g("sp-prev")).backgroundColor;
      g("sp-glyph").value = "交易"; g("sp-glyph").dispatchEvent(new Event("input"));
      g("sp-tag").value = "紀律比行情重要"; g("sp-tag").dispatchEvent(new Event("input"));
      g("sp-bg").value = "#123456"; g("sp-bg").dispatchEvent(new Event("input"));
      await new Promise((res)=>setTimeout(res,300));   /* 同上：等轉場跑完再量 */
      const mid = {
        tapClr: g("sp-clr-bg").getBoundingClientRect().height,
        tapColor: g("sp-bg").getBoundingClientRect().height, glyphValue:g("sp-glyph").value, markText:g("sp-mark").textContent,
        prevBg:getComputedStyle(g("sp-prev")).backgroundColor,
        sticky:getComputedStyle(g("sp-prev")).position };
      /* ⭐ 觸控目標**全掃描**：不列白名單逐個點名（上一輪就是列白名單，結果漏掉 #sp-reset）。
       * 這張 sheet 上每一個可互動元素都要 ≥44×44，之後再加新元件也會被這條掃到。 */
      var tapAll = Array.prototype.slice.call(
        document.querySelectorAll(".sheet button, .sheet input, .sheet textarea, .sheet select, .sheet [role=button]"));
      /* 沒被畫出來的（例如還沒自訂顏色、所以藏起來的「改回預設」）本來就點不到，不算數；
         但要把跳過幾個報出來，免得哪天整張表單都沒渲染還一片綠。 */
      var tapHidden = tapAll.filter(function(el){ return el.getClientRects().length === 0; }).length;
      const taps = tapAll.filter(function(el){ return el.getClientRects().length > 0; })
        .map(function(el){ var b = el.getBoundingClientRect();
          return { id: el.id || el.className || el.tagName, w: Math.round(b.width), h: Math.round(b.height) }; });
      /* 第三條路：守門訊息在手機上**實際被畫出來**的樣子 */
      g("sp-tag").value = "0a1b2c3d4e5f60718293a4b5c6d7e8f9"; g("sp-tag").dispatchEvent(new Event("input"));
      document.getElementById("sh-go").click();
      await new Promise((res)=>setTimeout(res,200));
      const toastText = document.getElementById("toast").textContent;
      const toastShown = !document.getElementById("toast").classList.contains("hidden");
      g("sp-tag").value = "紀律比行情重要"; g("sp-tag").dispatchEvent(new Event("input"));
      document.getElementById("sh-go").click();
      await new Promise((res)=>setTimeout(res,300));
      const ring = await buildKeyring(ST.P, "2026-08-25T00:00:00.000Z");
      return Object.assign(mid, { taps, tapHidden, toastText, toastShown, before, saved: window.__saved, app: ST.P.apps[0],
        ringApp: ring.apps[0], listHtml: appsHtml().indexOf("🎬") >= 0 });
    `);
    check("E8. ★ 手機後台：改顏色時縮圖跟著變、符號只留一個字",
      r.before === "rgb(16, 24, 32)" && r.prevBg === "rgb(18, 52, 86)" &&
      r.glyphValue === "交" && r.markText === "交",
      r.before + " → " + r.prevBg + "；符號=" + r.glyphValue);
    check("E9. 手機後台：縮圖是 sticky（鍵盤把版面推上去時還看得到）", r.sticky === "sticky", r.sticky);
    check("E10. ★ 手機後台：按存起來 → 真本裡真的有 splash，空值沒有被塞進去",
      eq(r.app.splash, { glyph: "交", bg: "#123456", tagline: "紀律比行情重要" }) && !!r.saved,
      JSON.stringify(r.app.splash) + "（" + r.saved + "）");
    check("E11. ★ 手機後台產的 keyring.json 也帶著 splash（兩套實作要產出同一種東西）",
      eq(r.ringApp, { id: "trade-log", name: "交易日誌", emoji: "📦",
        splash: { glyph: "交", bg: "#123456", tagline: "紀律比行情重要" } }),
      JSON.stringify(r.ringApp));
    check("E12. 手機後台：列表那一行看得到目前的開場設定", r.listHtml === true);
    /* ⚠️ 量的是 getBoundingClientRect，不是 CSS 裡寫的數字——CSS 值不等於實際佔位高度 */
    /* ⚠️ 量的是 getBoundingClientRect，不是 CSS 裡寫的數字；而且是**掃描全部**，不是點名幾個 */
    const small = (r.taps || []).filter((t) => t.w < 44 || t.h < 44);
    check("E13. ★ 手機後台：這張 sheet 上**每一個**可互動元素都 ≥ 44×44（全掃描，不列白名單）",
      small.length === 0 && (r.taps || []).length >= 10,
      "看得見的掃了 " + (r.taps || []).length + " 個（藏起來的 " + r.tapHidden + " 個不算）；不合格：" +
      (small.map((t) => t.id + " " + t.w + "×" + t.h).join("、") || "0 個"));
    check("E14. ★ 守門訊息在手機上真的以純文字顯示（第三條路：實際畫出來的 toast）",
      r.toastShown === true && mdHits(r.toastText).length === 0 && /^「標語」/.test(r.toastText),
      (mdHits(r.toastText).join("、") || "沒有 markdown 標記") + "｜" + String(r.toastText).slice(0, 30) + "…");
  } finally {
    if (br) { try { await br.close(); } catch (e) { } }
    try { s.ps.kill(); } catch (e) { }
    await sleep(200);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
}

(async function main() {
  console.log("開場外觀（splash）機器驗收 — 全程假金鑰、只在暫存資料夾讀寫");
  if (wants("A")) groupA();
  if (wants("B")) await groupB();
  if (wants("C")) await groupC();
  if (wants("D")) groupD();
  if (wants("E")) await groupE();
  const bad = results.filter((r) => !r.ok);
  console.log("\n" + (bad.length ? "❌ " + bad.length + " 條沒過：\n   " + bad.map((r) => r.name).join("\n   ")
    : "✅ 全部 " + results.length + " 條通過"));
  if (skipped.length) console.log("⏭ " + skipped.length + " 條未能測：\n   " + skipped.join("\n   "));
  process.exit(bad.length ? 1 : 0);
})();
