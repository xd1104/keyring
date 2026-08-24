"use strict";
/*
 * check-fields.js — 多欄位金鑰的機器驗收（零依賴，只用 node 內建）
 *
 *   node tools/check-fields.js            全部
 *   node tools/check-fields.js --only=A,C 只跑某幾組
 *
 * 為什麼要有這支：這個 repo 沒有 npm test，而 tools/check-unlock.js 是**瀏覽器**那一半
 * （它要 Chrome ＋ 旁邊的 travel-planner／recipe-book 兩個 repo）。這支管的是另一半：
 *   A. 共用邏輯（幾格 ←→ 一串）
 *   B. 向後相容：**跟改動前的 server.js 產出的 keyring.json 逐項比對**
 *      —— 旅途手帳／食譜本那種沒宣告欄位的 App，行為與產物一模一樣（這是硬需求）
 *   C. 本機後台 API 端到端：真的起一個 server.js（在暫存資料夾、用假金鑰）走完整流程
 *   D. keyring-unlock.js 的 CSS：滿版層按鈕有沒有把會被宿主 reset 的屬性寫死
 *
 * ⚠️ 全程用**假金鑰**（ghp_FAKE_…／TMDB_FAKE_…），而且只在 os.tmpdir() 底下讀寫；
 *    永遠不碰 repo 裡的 keyring.json／vault.json／secrets.json。
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
function head(t) { console.log("\n" + t); }
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").replace("--only=", "");
const wants = (g) => !ONLY || ONLY.split(",").indexOf(g) >= 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* 跟 server.js／keyring-unlock.js 同一套參數（要驗的就是「格式沒變」） */
const KDF = { iter: 600000, hash: "sha256", keyLen: 32 };
function deriveKey(pw, saltB64) {
  return crypto.pbkdf2Sync(Buffer.from(pw, "utf8"), Buffer.from(saltB64, "base64"), KDF.iter, KDF.keyLen, KDF.hash);
}
function decryptWithKey(keyBuf, ivB64, cipherB64) {
  const raw = Buffer.from(cipherB64, "base64");
  const tag = raw.subarray(raw.length - 16), body = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", keyBuf, Buffer.from(ivB64, "base64"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

/* ------------------------------------------------------------------ */
/* A. 共用邏輯                                                          */
/* ------------------------------------------------------------------ */
function groupA() {
  head("A  共用邏輯（client/keyring-fields.js）");
  const F = KF.presetFor("movie-library").fields;

  /* A0：「每個 App 一把、不從別的 App 沿用」這條規則**同時活在兩套實作裡**——
   * server.js（電腦端）與 web/admin.js（手機端直接寫 vault，不走 server）。
   * 2026-08-24 只修了電腦端，手機端照樣沿用，等於沒修。這條就是防這件事再發生：
   * 原始碼層級掃「把別的 App 的 token 抄過來」的痕跡。 */
  const donorHits = [];
  for (const rel of ["server.js", "web/admin.js", "public/admin.js"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    /* 只看真的會執行的賦值，註解裡講這段歷史不算 */
    const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    if (/=\s*donor\.token|token\s*=\s*donor\b/.test(code)) donorHits.push(rel);
  }
  check("A0. ★ 兩套實作都沒有「沿用別的 App 的金鑰」（鐵律：一個 App 一把）",
    donorHits.length === 0, donorHits.join("、") || "server.js／web/admin.js／public/admin.js 都乾淨");

  check("A1. 沒宣告欄位一律回 []（舊資料、壞資料都是）",
    eq(KF.normFields(undefined), []) && eq(KF.normFields(null), []) && eq(KF.normFields("abc"), []) &&
    eq(KF.normFields([{}, { key: "" }, 3]), []) && KF.isMulti({}) === false && KF.isMulti({ fields: [] }) === false,
    JSON.stringify(KF.normFields([{}, { key: "" }, 3])));

  check("A2. 欄位代號只收 ASCII 小寫（跟 App id 同一條鐵律）",
    KF.normKey("TMDB") === "tmdb" && KF.normKey("t-m d b") === "tmdb" && KF.normKey("中文") === "" &&
    KF.normKey("9key") === "k9key",
    [KF.normKey("TMDB"), KF.normKey("t-m d b"), JSON.stringify(KF.normKey("中文")), KF.normKey("9key")].join(" / "));

  check("A3. 重複的代號只留第一個、上限 " + KF.MAX_FIELDS + " 格",
    KF.normFields([{ key: "a" }, { key: "a" }]).length === 1 &&
    KF.normFields(Array.from({ length: 20 }, (_, i) => ({ key: "k" + i }))).length === KF.MAX_FIELDS);

  const s1 = KF.compose(F, { tmdb: "TMDB_FAKE_1", omdb: "OMDB_FAKE" });
  check("A4. 幾格 → 一串（照宣告順序，沒填的給空字串）",
    s1 === '{"tmdb":"TMDB_FAKE_1","omdb":"OMDB_FAKE"}', s1);
  check("A5. 只填第一格 → 第二格是空字串，不是不見",
    KF.compose(F, { tmdb: "TMDB_FAKE_1" }) === '{"tmdb":"TMDB_FAKE_1","omdb":""}',
    KF.compose(F, { tmdb: "TMDB_FAKE_1" }));

  const r1 = KF.parse(F, s1);
  check("A6. 一串 → 幾格（round-trip 一致）",
    r1.ok && r1.values.tmdb === "TMDB_FAKE_1" && r1.values.omdb === "OMDB_FAKE" &&
    KF.compose(F, r1.values, r1.extra) === s1, JSON.stringify(r1.values));

  const bad = KF.parse(F, "TMDB_FAKE_裸金鑰");
  check("A7. ★ 拆不開時整串放第一格、ok=false，**絕對不清空**",
    bad.ok === false && bad.values.tmdb === "TMDB_FAKE_裸金鑰" && bad.values.omdb === "" && bad.raw === "TMDB_FAKE_裸金鑰" && !!bad.message,
    JSON.stringify(bad.values) + " / " + bad.message);
  const bad2 = KF.parse(F, '["a","b"]');
  check("A8. 陣列／數字這種也算拆不開（不是物件就不是我們的格式）",
    bad2.ok === false && bad2.values.tmdb === '["a","b"]');

  const ex = KF.parse(F, '{"tmdb":"T","omdb":"O","legacy":"別弄丟我"}');
  check("A9. ★ 宣告以外的鍵原樣留著，存回去不會弄丟",
    ex.extra.legacy === "別弄丟我" && JSON.parse(KF.compose(F, ex.values, ex.extra)).legacy === "別弄丟我",
    KF.compose(F, ex.values, ex.extra));

  check("A10. 必填沒填會擋、可留空的不擋",
    KF.validate(F, { tmdb: "", omdb: "x" }).ok === false &&
    KF.validate(F, { tmdb: "x", omdb: "" }).ok === true,
    KF.validate(F, { tmdb: "", omdb: "x" }).message);

  check("A11. 空字串／空白＝沒有金鑰，不會變成 '\"\"' 這種怪東西",
    KF.parse(F, "").ok === true && KF.parse(F, "   ").values.tmdb === "");

  const mask = (t) => t.slice(0, 4) + "…";
  const reveal = (t) => t;          /* 故意傳一個「什麼都不遮」的函式進去 */
  check("A12. 列表摘要：單欄位沿用呼叫端的遮罩（旅途手帳／食譜本行為不變）",
    KF.maskSummary([], "ghp_FAKE_abcdef", mask) === "ghp_…", KF.maskSummary([], "ghp_FAKE_abcdef", mask));
  check("A12b. ★ 多欄位一律用自己那套更嚴的遮罩，就算呼叫端傳了「不遮」進來也不會漏",
    KF.maskSummary(F, s1, reveal).indexOf("TMDB_FAKE_1") < 0 &&
    KF.maskSummary(F, s1, reveal) === "tmdb TM•••••••• · omdb OM••••••••",
    KF.maskSummary(F, s1, reveal));
  check("A14. ★ 舊版後台送上來的資料沒有 fields 這個鍵 → 保留原本的宣告（不是清空）",
    KF.adoptFields({ id: "x", token: "t" }, { fields: F }).length === 2 &&
    KF.adoptFields({ id: "x", fields: [] }, { fields: F }).length === 0 &&
    KF.adoptFields({ id: "x", fields: F }, null).length === 2 &&
    KF.adoptFields({ id: "x" }, null).length === 0,
    "沒帶鍵→" + KF.adoptFields({ id: "x" }, { fields: F }).length +
    "格／帶空陣列→" + KF.adoptFields({ id: "x", fields: [] }, { fields: F }).length + "格");
  check("A15. 遮罩：整串都是祕密的金鑰只露前 4 後 2，短的整條遮掉",
    KF.maskField("0123456789abcdef0123456789abcdef") === "0123••••••••ef" &&
    KF.maskField("OMDBKEY8") === "••••••••" && KF.maskField("") === "",
    [KF.maskField("0123456789abcdef0123456789abcdef"), KF.maskField("OMDBKEY8")].join(" / "));
  check("A16. 合併：沒打字的格子留原值、按了清掉的變空",
    eq(KF.merge(F, { tmdb: "A", omdb: "B" }, { omdb: "NEW" }, []), { tmdb: "A", omdb: "NEW" }) &&
    eq(KF.merge(F, { tmdb: "A", omdb: "B" }, {}, ["omdb"]), { tmdb: "A", omdb: "" }) &&
    eq(KF.merge(F, { tmdb: "A", omdb: "B" }, {}, []), { tmdb: "A", omdb: "B" }),
    JSON.stringify(KF.merge(F, { tmdb: "A", omdb: "B" }, { omdb: "NEW" }, [])));

  check("A13. 好雷嗎的現成組合就是 tmdb ＋ omdb（omdb 可留空）",
    F.length === 2 && F[0].key === "tmdb" && F[1].key === "omdb" && F[1].optional === true);
}

/* ------------------------------------------------------------------ */
/* B. 向後相容：跟「改動前的 server.js」產出的東西比對                    */
/* ------------------------------------------------------------------ */
function fakeSecrets(withFields) {
  const salt = crypto.randomBytes(16).toString("base64");
  const dk = crypto.pbkdf2Sync(Buffer.from("pw-fake", "utf8"), Buffer.from(salt, "base64"),
    KDF.iter, KDF.keyLen, KDF.hash).toString("base64");
  const apps = [
    { id: "travel-book", name: "旅途手帳", emoji: "🧳", url: "", token: "ghp_FAKE_travel_0001" },
    { id: "recipe-book", name: "食譜本", emoji: "🍳", url: "", token: "ghp_FAKE_recipe_0002" }
  ];
  if (withFields) {
    apps.push({
      id: "movie-library", name: "好雷嗎", emoji: "🎬", url: "", token: "",
      fields: KF.presetFor("movie-library").fields
    });
  }
  return {
    version: 1, updatedAt: "2026-08-24T00:00:00.000Z",
    apps,
    users: [{ id: "u-fake", name: "測試", emoji: "🧔", theme: "ocean", salt, dk, apps: apps.map((a) => a.id) }],
    github: { token: "" }
  };
}
function decryptRing(ring, dk) {
  const out = {};
  const u = ring.users[0];
  Object.keys(u.apps).forEach((appId) => {
    out[appId] = decryptWithKey(Buffer.from(dk, "base64"), u.apps[appId].iv, u.apps[appId].cipher);
  });
  return out;
}

/* 把 repo 複製到暫存資料夾（不含真實資料檔），可指定用舊版 server.js */
function makeSandbox(label, oldServer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kr-check-" + label + "-"));
  for (const d of ["client", "public", "web"]) {
    fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  }
  if (oldServer) {
    fs.writeFileSync(path.join(dir, "server.js"),
      execFileSync("git", ["show", "main:server.js"], { cwd: ROOT, maxBuffer: 8e6 }));
    /* 舊版不認得 client/keyring-fields.js，但它本來就不 require 它，複製過去無妨 */
  } else {
    fs.copyFileSync(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  }
  return dir;
}
function startServer(dir, port) {
  const ps = spawn(process.execPath, [path.join(dir, "server.js")], {
    cwd: dir, env: Object.assign({}, process.env, { PORT: String(port) }), stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  ps.stdout.on("data", (b) => logs.push(String(b)));
  ps.stderr.on("data", (b) => logs.push(String(b)));
  return { ps, logs };
}
const RECORD = [];      /* 每一次 HTTP 回應的原文，給 F 組（紅線：回應裡不准出現明文金鑰）用 */
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
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
function raw(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => { RECORD.push({ method: "GET", path: p, status: res.statusCode, raw: s }); resolve(s); });
    }).on("error", reject);
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

async function groupB() {
  head("B  向後相容：沒宣告欄位的 App，產物與行為跟改動前一模一樣");
  const secrets = fakeSecrets(false);
  const dirs = [], procs = [];
  try {
    const out = {};
    for (const [label, oldOne, port] of [["new", false, 45231], ["old", true, 45232]]) {
      const dir = makeSandbox(label, oldOne);
      dirs.push(dir);
      fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(secrets, null, 2));
      const s = startServer(dir, port);
      procs.push(s.ps);
      const up = await waitUp(port);
      if (!up) { check("B0. " + label + " 版 server 起得來", false, s.logs.join("").slice(0, 300)); return; }
      /* 觸發一次寫入 → 產出 keyring.json（publish 會因為不是 git repo 而失敗，那是預期的） */
      const r = await req(port, "POST", "/apps/travel-book/users", { userIds: ["u-fake"] });
      if (!r.body || !r.body.ok) { check("B0. " + label + " 版寫得進去", false, r.raw.slice(0, 200)); return; }
      out[label] = {
        ring: JSON.parse(fs.readFileSync(path.join(dir, "keyring.json"), "utf8")),
        state: r.body.state
      };
    }
    const A = out.old.ring, B = out.new.ring;
    const strip = (r) => JSON.stringify({
      version: r.version, apps: r.apps,
      users: r.users.map((u) => ({ id: u.id, name: u.name, emoji: u.emoji, theme: u.theme, kdf: u.kdf,
        appIds: Object.keys(u.apps).sort(),
        entryKeys: Object.keys(u.apps).sort().map((k) => Object.keys(u.apps[k]).sort()) }))
    });
    check("B1. ★ keyring.json 的結構與改動前逐項相同（只有密文與 updatedAt 會不一樣）",
      strip(A) === strip(B), "舊 " + strip(A).slice(0, 160) + "\n      新 " + strip(B).slice(0, 160));
    check("B2. ★ apps[] 沒有多出任何欄位（欄位宣告不進公開檔）",
      eq(B.apps, [{ id: "travel-book", name: "旅途手帳", emoji: "🧳" }, { id: "recipe-book", name: "食譜本", emoji: "🍳" }]),
      JSON.stringify(B.apps));
    const dk = secrets.users[0].dk;
    const oldPlain = decryptRing(A, dk), newPlain = decryptRing(B, dk);
    check("B3. ★ 解出來的明文一模一樣（旅途手帳／食譜本拿到的還是原本那把）",
      eq(oldPlain, newPlain) && oldPlain["travel-book"] === "ghp_FAKE_travel_0001",
      JSON.stringify(newPlain));
    check("B4. 後台狀態：沒宣告欄位的 App fields=[]、遮罩字串跟舊版一樣",
      eq(out.new.state.apps.map((a) => a.fields), [[], []]) &&
      eq(out.new.state.apps.map((a) => a.masked), out.old.state.apps.map((a) => a.masked)),
      JSON.stringify(out.new.state.apps.map((a) => ({ id: a.id, fields: a.fields, masked: a.masked }))));
  } finally {
    procs.forEach((p) => { try { p.kill(); } catch (e) { } });
    dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { } });
  }
}

/* ------------------------------------------------------------------ */
/* C. 本機後台 API 端到端                                               */
/* ------------------------------------------------------------------ */
async function groupC() {
  head("C  本機後台 API：多欄位的完整流程（真的起 server.js，假金鑰）");
  const secrets = fakeSecrets(false);
  const dir = makeSandbox("api", false);
  fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(secrets, null, 2));
  const port = 45233;
  const s = startServer(dir, port);
  const plainOf = (id) => decryptRing(JSON.parse(fs.readFileSync(path.join(dir, "keyring.json"), "utf8")),
    secrets.users[0].dk)[id];
  try {
    if (!(await waitUp(port))) { check("C0. server 起得來", false, s.logs.join("").slice(0, 300)); return; }
    const F = KF.presetFor("movie-library").fields;
    const appOf = (r, id) => r.body.state.apps.find((a) => a.id === id);

    /* 1) 登記一個分兩格的 App */
    let r = await req(port, "POST", "/apps", { name: "好雷嗎", appId: "movie-library", emoji: "🎬", fields: F });
    check("C1. 登記時可以宣告欄位", r.body && r.body.ok && appOf(r, "movie-library").fields.length === 2,
      JSON.stringify(appOf(r, "movie-library").fields.map((f) => f.key)));

    /* 2) 兩格都填 */
    r = await req(port, "POST", "/apps/movie-library/token",
      { values: { tmdb: "TMDBFAKEKEY_AAAA_1111_2222_3333", omdb: "OMDBFAKE1" } });
    check("C2. ★ 兩格 → 存進去的還是「一串字」，解出來就是那串 JSON",
      plainOf("movie-library") === '{"tmdb":"TMDBFAKEKEY_AAAA_1111_2222_3333","omdb":"OMDBFAKE1"}', plainOf("movie-library"));

    /* 3) 只改一格：另一格原值留著（只進不出的合併） */
    r = await req(port, "POST", "/apps/movie-library/token", { values: { omdb: "OMDBFAKE2" } });
    check("C3. ★ 只改一格，另一格保持原值（前端根本拿不到原值，是 server 自己合併的）",
      plainOf("movie-library") === '{"tmdb":"TMDBFAKEKEY_AAAA_1111_2222_3333","omdb":"OMDBFAKE2"}', plainOf("movie-library"));

    /* 4) 明確清掉可留空的那格 */
    r = await req(port, "POST", "/apps/movie-library/token", { clear: ["omdb"] });
    check("C4. 「清掉這一格」→ 空字串（不是整個 key 不見）",
      plainOf("movie-library") === '{"tmdb":"TMDBFAKEKEY_AAAA_1111_2222_3333","omdb":""}', plainOf("movie-library"));

    /* 5) 必填不准清空 / 必填沒填 */
    r = await req(port, "POST", "/apps/movie-library/token", { clear: ["tmdb"] });
    check("C5. ★ 必填那格不准被清空（server 自己會擋，不是只靠前端）",
      r.status === 400 && /TMDB/.test(r.body.message), r.body && r.body.message);

    /* 6) 每格遮罩：畫面拿得到的只有這個 */
    let st = await req(port, "GET", "/state");
    let ml = appOf(st, "movie-library").fieldsMasked;
    check("C6. ★ 後台只拿得到每格的**遮罩**（TMDB 32 碼只露前 4 後 2）",
      ml.length === 2 && ml[0].masked === "TMDB••••••••33" && ml[0].filled === true &&
      ml[1].masked === "" && ml[1].filled === false, JSON.stringify(ml.map((x) => [x.key, x.masked, x.filled])));
    check("C7. 列表摘要也是遮罩", /tmdb TMDB••••••••33/.test(appOf(st, "movie-library").masked),
      appOf(st, "movie-library").masked);

    /* 7) 那支會回明文的端點已經整個刪掉 */
    r = await req(port, "GET", "/apps/movie-library/fieldvalues");
    check("C8. ★ 會回明文的端點已經不存在（404，不是「有條件才給」）", r.status === 404, r.raw.slice(0, 120));

    /* 8) 遷移：他以前手打的那串 JSON → 宣告欄位 → server 當場拆好存回去 */
    await req(port, "POST", "/apps", { name: "遷移測試", appId: "mig-app",
      token: '{"tmdb":"TMDBFAKEKEY_MIG_9999_8888_7777","omdb":"OMDBFAKE9"}' });
    r = await req(port, "POST", "/apps/mig-app/fields", { fields: F });
    check("C9. ★ 遷移：宣告欄位時 server 當場把那串拆成各格（明文沒有離開 server）",
      plainOf("mig-app") === '{"tmdb":"TMDBFAKEKEY_MIG_9999_8888_7777","omdb":"OMDBFAKE9"}' &&
      appOf(r, "mig-app").fieldsMasked[1].filled === true,
      JSON.stringify(appOf(r, "mig-app").fieldsMasked.map((x) => [x.key, x.masked])));

    /* 9) 少一個鍵的舊字串：補成空字串（正規化），原本有的值不動 */
    await req(port, "POST", "/apps", { name: "半套", appId: "half-app", token: '{"tmdb":"TMDBFAKEKEY_HALF_5555_4444_3333"}' });
    await req(port, "POST", "/apps/half-app/fields", { fields: F });
    check("C10. 舊字串少一個鍵 → 補成空字串，原本那把不動",
      plainOf("half-app") === '{"tmdb":"TMDBFAKEKEY_HALF_5555_4444_3333","omdb":""}', plainOf("half-app"));

    /* 10) 拆不開：一個位元組都不動 */
    await req(port, "POST", "/apps", { name: "壞格式", appId: "bad-app", token: "TMDBFAKEKEY_RAW_0000_1111_2222" });
    r = await req(port, "POST", "/apps/bad-app/fields", { fields: F });
    check("C11. ★ 拆不開 → **原本那串一個位元組都沒動**（不是改寫成 JSON）",
      plainOf("bad-app") === "TMDBFAKEKEY_RAW_0000_1111_2222" && r.body.migrated === false, plainOf("bad-app"));
    check("C12. 而且畫面上標得出「格式待確認」，整串當第一格顯示（遮罩）",
      appOf(r, "bad-app").fieldsOk === false && /格式待確認/.test(appOf(r, "bad-app").masked),
      appOf(r, "bad-app").masked);
    /* 他填了新的值才會真的動到 */
    await req(port, "POST", "/apps/bad-app/token", { values: { tmdb: "TMDBFAKEKEY_NEW_6666_5555_4444" } });
    check("C13. 他自己填了新值才改寫，而且是分格的格式",
      plainOf("bad-app") === '{"tmdb":"TMDBFAKEKEY_NEW_6666_5555_4444","omdb":""}', plainOf("bad-app"));

    /* 11) 改回一格 */
    r = await req(port, "POST", "/apps/bad-app/fields", { fields: [] });
    check("C14. 可以改回一格（行為完全回到原本那條路）",
      appOf(r, "bad-app").fields.length === 0 && appOf(r, "bad-app").fieldsMasked.length === 0);

    /* 12) 單欄位 App 完全沒變 */
    r = await req(port, "POST", "/apps/travel-book/token", { token: "ghp_FAKE_travel_NEW" });
    check("C15. ★ 單欄位 App 換金鑰：原樣存原樣出，一個字都沒變", plainOf("travel-book") === "ghp_FAKE_travel_NEW");
    r = await req(port, "POST", "/apps/travel-book/token", {});
    check("C16. 單欄位 App 沒貼東西還是回原本那句人話",
      r.status === 400 && /先貼上新的金鑰/.test(r.body.message), r.body && r.body.message);

    /* 13) 落地：宣告存在 secrets.json、公開檔沒有 */
    const sec = JSON.parse(fs.readFileSync(path.join(dir, "secrets.json"), "utf8"));
    check("C17. 欄位宣告存在 secrets.json（重開後台還在）",
      sec.apps.find((a) => a.id === "movie-library").fields.length === 2);
    check("C18. ★ 公開的 keyring.json 不含任何欄位宣告",
      !/fields/.test(fs.readFileSync(path.join(dir, "keyring.json"), "utf8")));

    /* 14) 舊版手機後台送上來的資料沒有 fields 這個鍵 → 保留原本的宣告 */
    const vaultLike = {
      version: 1, updatedAt: new Date(Date.now() + 60000).toISOString(),
      apps: sec.apps.map((a) => ({ id: a.id, name: a.name, emoji: a.emoji, url: a.url || "", token: a.token })),
      users: sec.users, github: { token: "" }
    };
    check("C19. （下一條的前置）舊版送上來的 apps 真的沒有 fields 這個鍵",
      vaultLike.apps.every((a) => !Object.prototype.hasOwnProperty.call(a, "fields")));
  } finally {
    try { s.ps.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
}

/* ------------------------------------------------------------------ */
/* F. ★ 紅線：後台任何 HTTP 回應都不准出現完整的金鑰                      */
/* ------------------------------------------------------------------ */
async function groupF() {
  head("F  ★ 紅線：跑一輪完整流程，掃描所有回應，不准出現任何一把完整金鑰");
  const SECRETS_IN_PLAY = [
    "ghp_FAKE_travel_0001", "ghp_FAKE_recipe_0002", "ghp_FAKE_travel_NEW2",
    "TMDBFAKEKEY_RED_1111_2222_3333", "OMDBFAKE7", "TMDBFAKEKEY_RED2_4444_5555_6666"
  ];
  const secrets = fakeSecrets(false);
  const dir = makeSandbox("red", false);
  fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(secrets, null, 2));
  const port = 45234;
  const s = startServer(dir, port);
  const from = RECORD.length;
  try {
    if (!(await waitUp(port))) { check("F0. server 起得來", false, s.logs.join("").slice(0, 300)); return; }
    const F = KF.presetFor("movie-library").fields;
    /* 一輪「他真的會做的事」：登記、宣告欄位、填兩格、只改一格、改名、換人、看狀態、拿公開檔 */
    await req(port, "GET", "/state");
    await req(port, "POST", "/apps", { name: "好雷嗎", appId: "movie-library", emoji: "🎬", fields: F });
    await req(port, "POST", "/apps/movie-library/token",
      { values: { tmdb: "TMDBFAKEKEY_RED_1111_2222_3333", omdb: "OMDBFAKE7" } });
    await req(port, "POST", "/apps/movie-library/token", { values: { tmdb: "TMDBFAKEKEY_RED2_4444_5555_6666" } });
    await req(port, "POST", "/apps", { id: "movie-library", name: "好雷嗎?", emoji: "🎬" });
    await req(port, "POST", "/apps/movie-library/users", { userIds: ["u-fake"] });
    await req(port, "POST", "/apps/travel-book/token", { token: "ghp_FAKE_travel_NEW2" });
    await req(port, "POST", "/apps/mig2/fields", { fields: F });         /* 404 也要掃 */
    await req(port, "GET", "/apps/movie-library/fieldvalues");           /* 已刪除的端點 */
    await req(port, "GET", "/state");
    await req(port, "POST", "/sync", {});
    await req(port, "GET", "/nope");
    await raw(port, "/keyring.json");
    await raw(port, "/vault.json");
    await raw(port, "/");

    const scanned = RECORD.slice(from);
    const hits = [];
    for (const rec of scanned) {
      for (const k of SECRETS_IN_PLAY) {
        if (rec.raw.indexOf(k) >= 0) hits.push(rec.method + " " + rec.path + " ← " + k);
      }
    }
    check("F1. ★ " + scanned.length + " 個回應裡，沒有任何一把完整金鑰",
      hits.length === 0, hits.slice(0, 4).join("\n      "));
    check("F2. 掃描量足夠（沒有因為請求爆掉而空掃）", scanned.length >= 14, scanned.length + " 個回應");
    const stateRaw = scanned.filter((r) => r.path === "/state").map((r) => r.raw).join("");
    check("F3. /state 確實有回東西（不是空的才「沒洩漏」）",
      stateRaw.length > 200 && /movie-library/.test(stateRaw), stateRaw.length + " 字元");
    check("F4. ★ 那支會回明文的端點已經不存在了（404）",
      scanned.some((r) => /fieldvalues/.test(r.path) && r.status === 404));
    check("F5. 遮罩本身有出現（證明畫面拿得到的是遮罩版）",
      /TMDB••••••••66/.test(stateRaw), (/(TMDB[^"]*)/.exec(stateRaw) || [])[1]);

    /* ── F6〜F9：2026-08-24 補。原本的紅線只掃「金鑰欄位」那條路，
     * 掃不到這次真的出事的地方——金鑰被貼進**說明（hint）**，而 hint 是自由文字、
     * 會被原樣印到「換金鑰」對話框上，於是同一格上面是遮罩、下面是明文。 */
    const HINT_SECRET = "c1209585fake41ddc7b39e075faa0a94";   /* 32 碼十六進位，長得就像 TMDB 金鑰 */
    const HINT_SECRET2 = "8b8610fa";                          /* 8 碼，長得就像 OMDb 金鑰 */
    const withSecretHints = [
      { key: "tmdb", label: "TMDB 金鑰", hint: HINT_SECRET, optional: false },
      { key: "omdb", label: "OMDb 金鑰", hint: HINT_SECRET2, optional: true },
    ];
    const before2 = RECORD.length;
    const rBad = await req(port, "POST", "/apps/movie-library/fields", { fields: withSecretHints });
    await req(port, "GET", "/state");
    const after2 = RECORD.slice(before2);

    check("F6. ★ 寫入端擋下來：說明欄位裡放金鑰會被拒絕（400）",
      rBad.status === 400 && /說明/.test(rBad.body && rBad.body.message || ""),
      rBad.status + " " + ((rBad.body && rBad.body.message) || "").slice(0, 60));

    const hintHits = after2.filter((r) => r.raw.indexOf(HINT_SECRET) >= 0 || r.raw.indexOf(HINT_SECRET2) >= 0);
    check("F7. ★ 就算擋下來，回應裡也不准把那串明文回音回去",
      hintHits.length === 0, hintHits.map((r) => r.method + " " + r.path).join(", "));

    /* 前 12 碼：金鑰被截斷後貼出來一樣是外洩。
     * ⚠️ 但要扣掉**公開前綴**再取：`github_pat_`／`ghp_` 那幾個字是 GitHub 的固定招牌，
     *    不是祕密。server.js 的 maskToken 刻意露前 14 碼就是基於這個理由
     *    （見 keyring-fields.js 的註解：真正是祕密的每格金鑰用的是更狠的 maskField）。
     *    不扣掉的話這條紅線會一直咬遮罩本身，變成永遠紅的雜訊——那跟永遠綠一樣沒用。 */
    const stripPublicPrefix = (k) => k.replace(/^(github_pat_|ghp_|gho_|ghs_|ghu_)/, "");
    const prefixes = SECRETS_IN_PLAY.map(stripPublicPrefix).filter((k) => k.length >= 12).map((k) => k.slice(0, 12));
    const preHits = [];
    for (const rec of RECORD.slice(from)) {
      for (const pfx of prefixes) if (rec.raw.indexOf(pfx) >= 0) preHits.push(rec.method + " " + rec.path + " ← " + pfx);
    }
    check("F8. ★ 連任何一把金鑰的**前 12 碼**都不准出現",
      preHits.length === 0, preHits.slice(0, 4).join("\n      "));

    /* ── F9／F10：2026-08-24 第二次踩到。擋掉「說明」之後，金鑰改被填進**標題**——
     * 因為那張表單只有代號／標題／說明，沒有放值的地方，人只會挑最像的那一格。
     * 守門不能只守一個欄位，任何會被原樣印到畫面上的自由文字都要守。 */
    const LABEL_SECRET = "a9f2c07dfake4bb1e63d80f5a1c7e204";
    const before3 = RECORD.length;
    const rBadL = await req(port, "POST", "/apps/movie-library/fields", {
      fields: [{ key: "tmdb", label: LABEL_SECRET, hint: "32 碼英數", optional: false }],
    });
    await req(port, "GET", "/state");
    const after3 = RECORD.slice(before3);
    check("F9. ★ 標題欄裡放金鑰一樣被拒絕（400），訊息要指出是「標題」",
      rBadL.status === 400 && /標題/.test((rBadL.body && rBadL.body.message) || ""),
      rBadL.status + " " + ((rBadL.body && rBadL.body.message) || "").slice(0, 50));
    check("F10. ★ 標題那串明文也不准回音回去",
      after3.filter((r) => r.raw.indexOf(LABEL_SECRET) >= 0).length === 0);
  } finally {
    try { s.ps.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
}

/* ------------------------------------------------------------------ */
/* G. 證明 F 那條紅線真的會紅（突變測試）                                 */
/* ------------------------------------------------------------------ */
/* 「掃了沒抓到」有兩種可能：真的沒外洩，或者尺根本是壞的。這一組把修法
 * 從沙箱裡的 server.js 拿掉（＝把 2026-08-24 修掉的洞放回去），再跑一次同樣的
 * 掃描——**必須變紅**。不會紅的紅線等於沒有紅線。 */
async function groupG() {
  head("G  ★ 突變測試：把修法拿掉，F 的掃描必須抓到");
  const HINT_SECRET = "d7f31a55fake92bb08c4e17099aa3b61";
  const secrets = fakeSecrets(false);
  const dir = makeSandbox("redproof", false);
  fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(secrets, null, 2));

  /* 突變：① 顯示端不再過 safeHint ② 寫入端不再擋 */
  const sp = path.join(dir, "server.js");
  let src = fs.readFileSync(sp, "utf8");
  /* ⚠️ 寫入端有**兩個**入口（POST /apps 與 POST /apps/:id/fields），兩個都要拿掉，
   * 否則金鑰在寫入時就被擋住、根本沒存進去，掃描當然抓不到——那會得到一個
   * 「紅線壞掉」的假結論。第一版就是漏了 POST /apps 那個。 */
  const m1 = src.includes("hint: KF.safeHint(f.hint)");
  const m2 = src.includes("const bad = badHint(fields);");
  const m3 = src.includes("const badNew = badHint(wantFields);");
  src = src.replace("hint: KF.safeHint(f.hint)", "hint: f.hint")
           .replace("const bad = badHint(fields);", "const bad = '';")
           .replace("const badNew = badHint(wantFields);", "const badNew = '';");
  fs.writeFileSync(sp, src);
  check("G0. 突變真的套用了（三處都要中，不然這一組等於沒測）", m1 && m2 && m3,
    "顯示端=" + m1 + " fields端=" + m2 + " 新增App端=" + m3);

  const port = 45235;
  const s = startServer(dir, port);
  const from = RECORD.length;
  try {
    if (!(await waitUp(port))) { check("G1. server 起得來", false, s.logs.join("").slice(0, 300)); return; }
    await req(port, "POST", "/apps", {
      name: "紅線測試", appId: "redproof", emoji: "🧪", token: "ghp_FAKE_redproof_1",
      fields: [{ key: "tmdb", label: "TMDB 金鑰", hint: HINT_SECRET, optional: false }],
    });
    await req(port, "GET", "/state");
    const hits = RECORD.slice(from).filter((r) => r.raw.indexOf(HINT_SECRET) >= 0);
    check("G1. ★ 拿掉修法之後，掃描確實抓到明文（證明 F6／F7 是承重的）",
      hits.length > 0, hits.map((r) => r.method + " " + r.path).join(", ") || "一個都沒抓到 ⇒ 尺是壞的");
  } finally {
    try { s.ps.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
}

/* ------------------------------------------------------------------ */
/* D. keyring-unlock.js 的 CSS（滿版層按鈕的宿主滲漏防護）               */
/* ------------------------------------------------------------------ */
function groupD() {
  head("D  解鎖模組：滿版層按鈕有沒有把會被宿主 reset 掉的屬性寫死");
  /* 用一個最小的假 document 把模組真正注入的 CSS 抓出來（不是 grep 原始碼，
     grep 會被註解與字串誤導；這裡拿到的是實際會塞進 <style> 的那份） */
  let css = "";
  const g = globalThis;
  const saved = { window: g.window, document: g.document };
  const style = { id: "", textContent: "" };
  g.document = {
    getElementById: () => null,
    getElementsByTagName: () => [{ appendChild: () => { css = style.textContent; } }],
    createElement: () => style,
    addEventListener: () => { },
    head: { appendChild: () => { css = style.textContent; } }
  };
  g.window = g;
  try {
    delete require.cache[require.resolve(path.join(ROOT, "client", "keyring-unlock.js"))];
    const K = require(path.join(ROOT, "client", "keyring-unlock.js"));
    K.init({ appId: "check-fields", tokenKey: "x", enabled: true, url: "about:blank" });
    K.chipHtml();
  } catch (e) {
    check("D0. 抽得出模組的 CSS", false, String(e && e.message));
    return;
  } finally {
    g.window = saved.window; g.document = saved.document;
    if (saved.window === undefined) delete g.window;
    if (saved.document === undefined) delete g.document;
  }
  check("D0. 抽得出模組的 CSS", css.length > 5000, css.length + " 字元");

  const block = (sel) => {
    const i = css.indexOf(sel + "{");
    if (i < 0) return "";
    return css.slice(i, css.indexOf("}", i) + 1);
  };
  /* 宿主的 `button{padding:0}` 這種 reset 會滲進來的屬性 */
  const MUST = ["padding", "margin", "font-family", "line-height", "letter-spacing", "text-align",
    "box-sizing", "appearance", "text-transform", "text-indent", "word-spacing"];
  for (const sel of ["#kr-full .kr-go", "#kr-full .kr-ghost", "#kr-full .kr-danger"]) {
    const b = block(sel);
    const miss = MUST.filter((p) => b.indexOf(p + ":") < 0);
    check("D1. " + sel + " 把宿主會 reset 的屬性都寫死了",
      !!b && miss.length === 0, b ? ("缺：" + miss.join("、")) : "找不到這條規則");
  }
  check("D2. .kr-chip 仍然用自我加倍（層外沒有 id 可以綁，這條不能改成單一 class）",
    /\.kr-chip\.kr-chip\{/.test(css));
  check("D3. 主鈕的漸層 sheen 還在（check-unlock D2 也在驗這件事）",
    /gradient/.test(block("#kr-full .kr-go")));
  /* 滿版層內不准讀宿主變數（check-unlock 的 B 條；這裡對抽出來的 CSS 再擋一次） */
  const fullRules = css.split("}").filter((r) => r.indexOf("#kr-full") >= 0);
  const badVar = fullRules.filter((r) => /var\(--(?!krs-|kr-)/.test(r));
  check("D4. #kr-full 子樹一個宿主變數都沒讀（我這次加的宣告也沒有）",
    badVar.length === 0, badVar.slice(0, 2).join(" | ").slice(0, 200));
}

/* ------------------------------------------------------------------ */
/* E. 兩個後台的畫面產生器（純字串，不用瀏覽器也驗得到）                  */
/* ------------------------------------------------------------------ */
function loadAdmin(file, extraGlobals) {
  const vm = require("vm");
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const noop = () => { };
  const el = () => ({ value: "", checked: false, textContent: "", className: "", hidden: true,
    innerHTML: "", style: {}, focus: noop, onclick: null, onchange: null, oninput: null,
    querySelectorAll: () => [], querySelector: () => null, appendChild: noop, addEventListener: noop });
  const ctx = {
    document: { getElementById: () => el(), createElement: el, addEventListener: noop,
      querySelectorAll: () => [], querySelector: () => null, body: el(), head: el() },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState: noop },
    fetch: () => new Promise(() => { }),      /* 開機那支 api() 永遠不會回來，剛好不干擾 */
    setTimeout: noop, clearTimeout: noop, console,
    crypto: { getRandomValues: (a) => a, subtle: {} },
    KeyringFields: KF, TextEncoder, TextDecoder, atob: () => "", btoa: () => ""
  };
  ctx.window = ctx;
  Object.assign(ctx, extraGlobals || {});
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: file });
  return ctx;
}
function groupE() {
  head("E  兩個後台的畫面產生器（純字串，不用瀏覽器）");
  const F = KF.presetFor("movie-library").fields;

  let a = null;
  try { a = loadAdmin("public/admin.js"); } catch (e) {
    check("E0. public/admin.js 載得起來", false, String(e && e.message)); return;
  }
  check("E0. public/admin.js 載得起來（沒有語法／啟動期錯誤）", typeof a.render === "function");
  const need = ["fieldsEditorHtml", "fieldSet", "fieldAdd", "fieldDel", "fieldClear", "fieldPreset",
    "formRedraw", "openFieldsForm", "drawFieldsForm", "saveFields", "drawKeyFormMulti", "saveKeyMulti"];
  const missing = need.filter((n) => typeof a[n] !== "function");
  check("E1. 多欄位用到的函式都在（onclick 裡打錯字在瀏覽器上是靜靜壞掉）",
    missing.length === 0, "缺：" + missing.join("、"));

  a.formState = { mode: "app", fields: JSON.parse(JSON.stringify(F)), appId: "movie-library" };
  const html = a.fieldsEditorHtml();
  check("E2. 欄位編輯器畫得出兩格 ＋ 現成組合按鈕",
    (html.match(/class="fieldrow"/g) || []).length === 2 && /fieldPreset\('movie-library'\)/.test(html) &&
    /fieldAdd\(\)/.test(html) && /fieldClear\(\)/.test(html));
  a.formState.fields = [{ key: "x", label: '<img src=x onerror=1>"', hint: "", optional: false }];
  check("E3. 使用者填的字有跳脫（後台自己也是外部輸入）",
    a.fieldsEditorHtml().indexOf("<img src=x") < 0 && /&lt;img/.test(a.fieldsEditorHtml()));
  a.formState.fields = [];
  check("E4. 一格都沒有時：不畫 fieldrow，但仍看得到「套用現成組合」",
    (a.fieldsEditorHtml().match(/class="fieldrow"/g) || []) .length === 0 && /fieldPreset/.test(a.fieldsEditorHtml()));

  /* 登記表單：有宣告欄位時不該再要求貼「一把」金鑰 */
  a.S = { apps: [{ id: "travel-book", name: "旅途手帳", emoji: "🧳", masked: "x", fields: [] }], users: [] };
  let dialog = "";
  a.openDialog = (h) => { dialog = h; };
  a.formState = { mode: "app", emoji: "🎬", fields: JSON.parse(JSON.stringify(F)), appId: "movie-library", name: "好雷嗎", url: "", token: "" };
  a.drawAppForm();
  check("E5. 分格的 App 登記表單不再叫他貼「一把」金鑰", dialog.indexOf('id="af-key"') < 0 && /fieldrow/.test(dialog));
  a.formState.fields = [];
  a.drawAppForm();
  check("E6. 沒分格時登記表單跟以前一模一樣（還是那一格）", dialog.indexOf('id="af-key"') >= 0);

  /* 換金鑰（多欄位）畫面：只有遮罩、留空＝不改 */
  const MK = KF.maskedFields(F, JSON.stringify({ tmdb: "TMDBFAKEKEY_UI_1111_2222_3333", omdb: "OMDBFAKE5" }));
  a.formState = { mode: "key", id: "movie-library", fields: F, masked: MK, parsed: true, clear: [] };
  a.drawKeyFormMulti({ name: "好雷嗎" });
  check("E7. 換金鑰畫面：兩格、輸入框是空的（留空＝不改）",
    (dialog.match(/id="kf-\d"/g) || []).length === 2 && /留空＝不改這一格/.test(dialog) && !/value="TMDB/.test(dialog));
  check("E7b. ★ 畫面上只有遮罩，沒有任何明文金鑰",
    dialog.indexOf("TMDBFAKEKEY_UI_1111_2222_3333") < 0 && dialog.indexOf("OMDBFAKE5") < 0 &&
    dialog.indexOf("TMDB••••••••33") >= 0, (/(TMDB[^<]*)/.exec(dialog) || [])[1]);
  check("E7c. 可留空又有值的那格才給「清掉這一格」",
    (dialog.match(/id="kc-\d"/g) || []).length === 1 && /id="kc-1"/.test(dialog));
  a.formState.parsed = false;
  a.drawKeyFormMulti({ name: "好雷嗎" });
  check("E7d. 拆不開時畫面會講清楚，而且承諾「按存檔前不會動」",
    /舊格式/.test(dialog) && /一個字都不會動/.test(dialog));

  /* 手機後台 */
  let w = null;
  try { w = loadAdmin("web/admin.js"); } catch (e) {
    check("E8. web/admin.js 載得起來", false, String(e && e.message)); return;
  }
  const need2 = ["fieldsEditorHtml", "readFieldsEditor", "wireFieldsEditor", "appFieldsSheet",
    "appTokenSheetMulti", "appSheetDraw"];
  const missing2 = need2.filter((n) => typeof w[n] !== "function");
  check("E8. web/admin.js 載得起來、多欄位函式都在", missing2.length === 0, "缺：" + missing2.join("、"));
  const h2 = w.fieldsEditorHtml(F, "movie-library");
  check("E9. 手機後台的欄位編輯器也畫得出兩格",
    (h2.match(/class="fieldrow"/g) || []).length === 2 && /fe-add/.test(h2) && /fe-preset/.test(h2));
  let sheet = "";
  w.openSheet = (t, body) => { sheet = body; };
  w.appTokenSheetMulti({ name: "好雷嗎", token: '{"tmdb":"TMDBFAKEKEY_UI_1111_2222_3333","omdb":"OMDBFAKE5"}' }, F);
  check("E10. 手機後台換金鑰：兩格、輸入框是空的（留空＝不改）",
    (sheet.match(/id="mf-\d"/g) || []).length === 2 && /留空＝不改這一格/.test(sheet) &&
    /placeholder="留空就不動它"/.test(sheet));
  check("E10b. ★ 手機後台也是只有遮罩，不預填明文（跟本機後台同一個姿態）",
    sheet.indexOf("TMDBFAKEKEY_UI_1111_2222_3333") < 0 && sheet.indexOf("OMDBFAKE5") < 0 &&
    sheet.indexOf("TMDB••••••••33") >= 0);
  w.appTokenSheetMulti({ name: "壞的", token: "TMDBFAKEKEY_RAW_9999_8888_7777" }, F);
  check("E11. 手機後台：拆不開時有提醒，而且不預填那一串",
    /note bad/.test(sheet) && sheet.indexOf("TMDBFAKEKEY_RAW_9999_8888_7777") < 0 && /TMDB••••••••77/.test(sheet),
    (/(TMDB[^<]*)/.exec(sheet) || [])[1]);

  /* ── E12〜E14：2026-08-24 補。直接重現被回報的那個畫面——
   * 欄位的「說明」裡放了一把長得像真金鑰的字串（實際發生過），
   * 換金鑰對話框把它原樣印在遮罩那行後面，於是同一格出現兩個對不起來的「現況」。
   * 這裡驗的是**畫面產生器的輸出**，不是 HTTP 回應（那條在 F 組）。 */
  const HINTKEY = "c1209585fake41ddc7b39e075faa0a94";
  const Fh = [
    { key: "tmdb", label: "TMDB 金鑰", hint: HINTKEY, optional: false },
    { key: "omdb", label: "OMDb 金鑰", hint: "8b8610fa", optional: true },
  ];
  const MKh = KF.maskedFields(Fh, JSON.stringify({ tmdb: "TMDBFAKEKEY_UI_1111_2222_3333", omdb: "" }));

  a.formState = { mode: "key", id: "movie-library", fields: Fh, masked: MKh, parsed: true, clear: [] };
  a.drawKeyFormMulti({ name: "好雷嗎" });
  check("E12. ★ 本機後台換金鑰：說明欄裡的金鑰不會被印到畫面上",
    dialog.indexOf(HINTKEY) < 0 && dialog.indexOf("8b8610fa") < 0 && /看起來像一把金鑰/.test(dialog),
    (/(⚠[^<]*)/.exec(dialog) || [])[1] || dialog.slice(0, 120));
  check("E13. ★ 說明另起一行，不會跟「目前 …」黏成同一句（那正是兩個現況對不起來的原因）",
    !/留空＝不改這一格[^<]*[0-9a-f]{8}/.test(dialog));

  w.appTokenSheetMulti({ name: "好雷嗎", token: '{"tmdb":"TMDBFAKEKEY_UI_1111_2222_3333","omdb":""}' }, Fh);
  check("E14. ★ 手機後台同樣不印（兩個介面同一個姿態）",
    sheet.indexOf(HINTKEY) < 0 && sheet.indexOf("8b8610fa") < 0 && /看起來像一把金鑰/.test(sheet),
    (/(⚠[^<]*)/.exec(sheet) || [])[1] || sheet.slice(0, 120));

  /* 反向對照：正常的說明**必須**照常顯示。少了這條，上面三條可能只是因為
   * 「說明根本沒被畫出來」才綠的——那種綠是假的。 */
  const NORMAL = "32 碼英數，在 TMDB 的設定頁拿";
  const Fn = [{ key: "tmdb", label: "TMDB 金鑰", hint: NORMAL, optional: false }];
  a.formState = { mode: "key", id: "movie-library", fields: Fn,
    masked: KF.maskedFields(Fn, JSON.stringify({ tmdb: "TMDBFAKEKEY_UI_1111_2222_3333" })), parsed: true, clear: [] };
  a.drawKeyFormMulti({ name: "好雷嗎" });
  const okDesk = dialog.indexOf(NORMAL) >= 0;
  w.appTokenSheetMulti({ name: "好雷嗎", token: '{"tmdb":"TMDBFAKEKEY_UI_1111_2222_3333"}' }, Fn);
  check("E15. 反向對照：正常的說明照常顯示（證明上面三條不是恆綠）",
    okDesk && sheet.indexOf(NORMAL) >= 0, "本機=" + okDesk + " 手機=" + (sheet.indexOf(NORMAL) >= 0));

  /* E16／E17：標題欄放金鑰（第二次實際發生的形狀）。標題不能整個藏掉——
   * 那格會變成沒有名字——所以退回用代號當標題並標記。 */
  const LABELKEY = "a9f2c07dfake4bb1e63d80f5a1c7e204";
  const Fl = [{ key: "tmdb", label: LABELKEY, hint: "32 碼英數", optional: false }];
  const viewFl = Fl.map((f) => ({ key: f.key, optional: f.optional, hint: f.hint,
    label: KF.safeLabel(f.label, f.key), labelHidden: KF.looksSecret(f.label) }));
  a.formState = { mode: "key", id: "movie-library", fields: viewFl,
    masked: KF.maskedFields(Fl, JSON.stringify({ tmdb: "TMDBFAKEKEY_UI_1111_2222_3333" })), parsed: true, clear: [] };
  a.drawKeyFormMulti({ name: "好雷嗎" });
  check("E16. ★ 標題欄裡的金鑰不會被印到畫面上，那格改用代號當名字",
    dialog.indexOf(LABELKEY) < 0 && /tmdb/.test(dialog) && /標題看起來像金鑰/.test(dialog),
    (/(tmdb[^<]*)/.exec(dialog) || [])[1] || dialog.slice(0, 120));

  a.formState = { mode: "app", fields: viewFl, appId: "movie-library" };
  check("E17. ★ 欄位編輯器也不把它回填進輸入框（否則一存檔就把金鑰寫回去）",
    a.fieldsEditorHtml().indexOf(LABELKEY) < 0);
}

/* ------------------------------------------------------------------ */
(async function run() {
  console.log("鑰匙圈 — 多欄位金鑰檢查（假金鑰、只在暫存資料夾讀寫）");
  if (wants("A")) groupA();
  if (wants("B")) await groupB();
  if (wants("C")) await groupC();
  if (wants("D")) groupD();
  if (wants("E")) groupE();
  if (wants("F")) await groupF();
  if (wants("G")) await groupG();
  const bad = results.filter((r) => !r.ok);
  console.log("\n" + "=".repeat(64));
  console.log(bad.length
    ? "❌ " + bad.length + " / " + results.length + " 條沒過：\n   - " + bad.map((r) => r.name).join("\n   - ")
    : "✅ 全部 " + results.length + " 條通過");
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error("\n跑不完：", e); process.exit(2); });
