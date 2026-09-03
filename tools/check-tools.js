"use strict";
/*
 * check-tools.js — 🧰 工具分頁的機器驗收（純 node，零依賴）
 *
 * 驗的是「把 tool-manager 的行程管理搬進鑰匙圈」這件事有沒有真的成立：
 *   A 清單：9 筆進來、鑰匙圈自己被拿掉、欄位語意沒變
 *   B 啟動／停止：真的起得來、taskkill 殺的是**整棵樹**（孫程序也要死）
 *   C 偵測：「不是我開的但已經在跑」判斷正確；管理器自己與它的子孫要被排除
 *   D 突變：把子樹排除拿掉，C 的斷言必須翻紅（證明 C 是承重的，不是恆綠）
 *   E 只接受本機連線 ＋ 跨來源 POST 被擋
 *   F 重啟：殺掉到重開之間那 1.2 秒，狀態要說「啟動中」不是「沒在跑」
 *   G 突變：拿掉 F 的空窗標記，F2 必須翻紅
 *   H 孤兒：只有 port 認得出來的（沒有視窗可以關）也要停得掉
 *   I 收工：/api/shutdown 要把面板開過的工具一起帶走（孤兒的根因）
 *
 * ⚠️ 全程在 os.tmpdir() 底下的沙箱跑，用**自己造的假工具**（__tmp__faketool.js），
 *    一次都不會去啟動 Benson 真正的那幾支程式，也不碰
 *    keyring.json／vault.json／secrets.json／tools.local.json。
 * ⚠️ 每一組「掃了沒問題」的結論都配一個負控組（故意弄壞要翻紅），
 *    因為看到全綠更要懷疑尺是不是死的。
 */
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7)
  .split(",").filter(Boolean).map((s) => s.toUpperCase());
function want(g) { return !only.length || only.indexOf(g) >= 0; }
function head(t) { console.log("\n" + t); }
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  \u2705 " + name); }
  else { fail++; console.log("  \u274C " + name); }
  if (detail) console.log("      " + String(detail).split("\n").join("\n      "));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 沙箱 ---------- */
/* 假工具：會生一個孫程序（只殺父 pid 的話它會活下來，taskkill /t 才殺得掉），
 * 有 FAKE_PORT 就順便開一個 port，讓「啟動中 → 運行中」那條路也走得到。 */
const FAKE_TOOL = [
  "const http=require('http');",
  "const {spawn}=require('child_process');",
  "const fs=require('fs');",
  "const port=Number(process.env.FAKE_PORT||0);",
  "const kid=spawn(process.execPath,['-e','setInterval(function(){},1e9)'],{stdio:'ignore'});",
  "if(process.env.FAKE_OUT) fs.writeFileSync(process.env.FAKE_OUT,JSON.stringify({pid:process.pid,kid:kid.pid}));",
  "console.log('fake tool up pid='+process.pid+' kid='+kid.pid);",
  "if(port) http.createServer(function(q,s){s.end('ok');}).listen(port,'127.0.0.1');",
  "setInterval(function(){},1e9);",
].join("\n");

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "krtools-"));
  for (const d of ["client", "public", "web"]) {
    fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  fs.writeFileSync(path.join(dir, "__tmp__faketool.js"), FAKE_TOOL);
  return dir;
}
function writeTools(dir, list) {
  fs.writeFileSync(path.join(dir, "tools.local.json"), JSON.stringify(list, null, 2));
}
function startServer(dir, port) {
  const ps = spawn(process.execPath, [path.join(dir, "server.js")], {
    cwd: dir, env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  ps.stdout.on("data", (b) => logs.push(String(b)));
  ps.stderr.on("data", (b) => logs.push(String(b)));
  return { ps, logs };
}
function req(port, method, p, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: "127.0.0.1", port, method, path: "/api" + p, headers: headers || {},
    }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(s); } catch (e) { }
        resolve({ status: res.statusCode, json: j, raw: s });
      });
    });
    r.on("error", reject);
    r.end();
  });
}
async function waitUp(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 12000)) {
    try { const r = await req(port, "GET", "/state"); if (r.status === 200) return true; } catch (e) { }
    await sleep(150);
  }
  return false;
}
function alive(pid) {
  if (!pid) return false;
  const r = spawnSync("tasklist", ["/FI", "PID eq " + pid, "/NH", "/FO", "CSV"], { encoding: "utf8" });
  return String(r.stdout || "").indexOf("\"" + pid + "\"") >= 0;
}
function toolOf(list, id) { return (list || []).find((t) => t.id === id) || null; }

/* 收沙箱那台 server：一定要走 /api/shutdown。
 * 直接 ps.kill() 是硬殺，它 spawn 的假工具會活下來變孤兒 ——
 * 下次跑整套時 B 組就會被自己上一輪的殘骸擋住（「已經有外部程序在跑了」）。 */
async function stopServer(s, port) {
  try { await req(port, "POST", "/shutdown"); } catch (e) { }
  for (let i = 0; i < 30; i++) {
    if (s.ps.exitCode !== null) return;
    await sleep(150);
  }
  try { s.ps.kill(); } catch (e) { }
}

/* ================================================================= */
/* A. 清單：搬過來的 9 筆一個不漏，鑰匙圈自己被拿掉                     */
/* ================================================================= */
function groupA() {
  head("A  清單搬遷：tool-manager 的 9 筆 → 鑰匙圈（自己不算）");
  const SRC = "C:/Users/USER/Desktop/Claude Work/tool-manager/tools.json";
  const DST = path.join(ROOT, "tools.local.json");
  let src = null, dst = null;
  try { src = JSON.parse(fs.readFileSync(SRC, "utf8")); } catch (e) { }
  try { dst = JSON.parse(fs.readFileSync(DST, "utf8")); } catch (e) { }
  if (!dst) { check("A0. 讀得到 keyring/tools.local.json", false, DST); return; }
  check("A0. 讀得到 keyring/tools.local.json", true, dst.length + " 筆");
  check("A1. \u2605 鑰匙圈自己不在清單裡（它就是面板本身）",
    !dst.some((t) => t.id === "keyring"));
  if (!src) {
    check("A2. （來源已退役、找不到 tool-manager，逐筆比對跳過）", true, SRC);
  } else {
    check("A2. 來源真的是 9 筆（不然下面的比對沒有意義）", src.length === 9, src.length + " 筆");
    const kept = src.filter((t) => t.id !== "keyring");
    const missing = kept.filter((t) => !dst.some((d) => d.id === t.id)).map((t) => t.id);
    check("A3. \u2605 除了鑰匙圈，來源每一筆都搬過來了（一個不漏）",
      missing.length === 0 && dst.length === kept.length,
      "缺：" + (missing.join("、") || "無") + "｜來源 " + kept.length + " / 這邊 " + dst.length);
    const diff = kept.filter((t) => JSON.stringify(toolOf(dst, t.id)) !== JSON.stringify(t)).map((t) => t.id);
    check("A4. \u2605 每一筆的欄位逐位元組相同（語意沒有被改寫）",
      diff.length === 0, "不同：" + (diff.join("、") || "無"));
    const tampered = JSON.parse(JSON.stringify(kept[0]));
    tampered.command = tampered.command + " --x";
    check("A5. \u2605 負控組：故意改一個欄位，A4 的比法真的比得出來",
      JSON.stringify(toolOf(dst, tampered.id)) !== JSON.stringify(tampered));
  }
  const need = ["id", "name", "emoji", "description", "category", "cwd", "command", "port", "url", "processMatch"];
  const bad = dst.filter((t) => need.some((k) => !(k in t))).map((t) => t.id);
  check("A6. 欄位語意不變（每一筆該有的鍵都在）", bad.length === 0, "缺鍵：" + (bad.join("、") || "無"));
  check("A7. \u2605 tools.local.json 有被 .gitignore 忽略（存檔跑 git add -A ＋ push 到公開 repo）",
    spawnSync("git", ["check-ignore", "-q", "tools.local.json"], { cwd: ROOT }).status === 0);
  /* 結構斷言：工具的路由必須排在 beforeChange() 之前——按一下「啟動」不該去 git fetch */
  const srcJs = fs.readFileSync(path.join(ROOT, "server.js"), "utf8").replace(/\r\n/g, "\n");
  const iTools = srcJs.indexOf("if (p === '/tools' && m === 'GET')");
  const iBefore = srcJs.indexOf("await beforeChange();");
  check("A8. /api/tools 的路由排在 beforeChange() 之前（啟動工具不該觸發跟 GitHub 對時）",
    iTools > 0 && iBefore > 0 && iTools < iBefore, "tools@" + iTools + " beforeChange@" + iBefore);
}

/* ================================================================= */
/* B～E：真的把 server 跑起來                                          */
/* ================================================================= */
async function groupsLive() {
  const dir = makeSandbox();
  const PORT = 45400;
  const FAKE_PORT = 45401;
  const ORPHAN_PORT = 45402;
  const mark = path.basename(dir);              /* 只會出現在 server 自己的指令列裡 */
  const outA = path.join(dir, "__tmp__a.json").replace(/\\/g, "/");
  const outE = path.join(dir, "__tmp__e.json").replace(/\\/g, "/");
  const outH = path.join(dir, "__tmp__h.json").replace(/\\/g, "/");

  writeTools(dir, [
    { id: "fake-a", name: "假工具A", emoji: "🧪", description: "測試用", category: "作品",
      cwd: dir, command: "node __tmp__faketool.js", port: FAKE_PORT,
      url: "http://localhost:" + FAKE_PORT, autostart: false, processMatch: "__tmp__faketool",
      env: { FAKE_PORT: String(FAKE_PORT), FAKE_OUT: outA } },
    /* 同一個 needle、但沒有 port：fake-a 由面板啟動時，這一筆必須是「沒在跑」
     * ——因為那個程序是面板自己的子孫，要被排除掉。 */
    { id: "subtree-probe", name: "子樹探針", emoji: "🧷", description: "驗子孫排除", category: "作品",
      cwd: dir, command: "node -e 0", port: null, url: null, autostart: false,
      processMatch: "__tmp__faketool" },
    /* needle 只命中 server 自己的指令列：必須永遠「沒在跑」 */
    { id: "self-probe", name: "自我探針", emoji: "🪞", description: "驗自己排除", category: "AI 工具",
      cwd: dir, command: "node -e 0", port: null, url: null, autostart: false, processMatch: mark },
    /* 外部啟動偵測用（由測試自己開，不經過面板） */
    { id: "fake-ext", name: "假工具B", emoji: "🧫", description: "外部啟動", category: "AI 工具",
      cwd: dir, command: "node -e 0", port: null, url: null, autostart: false,
      processMatch: "__tmp__extmark" },
    /* 負控組：這個 needle 不可能命中任何東西 */
    { id: "never", name: "不存在", emoji: "🚫", description: "負控組", category: "AI 工具",
      cwd: dir, command: "node -e 0", port: null, url: null, autostart: false,
      processMatch: "__tmp__no_such_process_zzz" },
    /* 孤兒：processMatch 故意對不上，只有 port 認得出來。
     * 模擬「面板開了它（windowsHide，沒有視窗）→ 後台被硬殺 → 它活下來」那個狀況。 */
    { id: "orphan", name: "孤兒工具", emoji: "🧟", description: "只認得出 port", category: "作品",
      cwd: dir, command: "node -e 0", port: ORPHAN_PORT, url: null, autostart: false,
      processMatch: "__tmp__no_such_process_zzz" },
    /* 防呆：就算有人把鑰匙圈那筆貼回來，也不准出現在清單裡 */
    { id: "keyring", name: "鑰匙圈", emoji: "🔑", description: "自己", category: "AI 工具",
      cwd: dir, command: "node -e 0", port: null, url: null, autostart: false, processMatch: "keyring" },
  ]);

  const s = startServer(dir, PORT);
  const extras = [];
  try {
    if (!(await waitUp(PORT))) {
      check("B0. sandbox 的 server 起得來", false, s.logs.join("").slice(0, 400));
      return;
    }
    check("B0. sandbox 的 server 起得來", true);

    /* ---------------- B. 啟動／停止 ---------------- */
    if (want("B")) {
      head("B  啟動／停止：真的起得來，而且殺的是整棵行程樹");
      let r = await req(PORT, "GET", "/tools");
      check("B1. 清單列得出來，鑰匙圈那筆被濾掉了",
        r.status === 200 && r.json.tools.length === 6 && !toolOf(r.json.tools, "keyring"),
        "回了 " + (r.json && r.json.tools ? r.json.tools.length : "?") + " 筆");
      check("B2. 還沒啟動 → 沒在跑", toolOf(r.json.tools, "fake-a").status === "stopped");

      r = await req(PORT, "POST", "/tools/fake-a/start");
      check("B3. \u2605 啟動回 ok ＋ 拿到 pid", r.status === 200 && r.json.ok && r.json.pid > 0,
        JSON.stringify(r.json));

      let sawStarting = false, ran = false;
      for (let i = 0; i < 60; i++) {
        const q = await req(PORT, "GET", "/tools");
        const t = toolOf(q.json.tools, "fake-a");
        if (t.status === "starting") sawStarting = true;
        if (t.status === "running" && t.managed && !t.external) { ran = true; break; }
        await sleep(200);
      }
      check("B4. \u2605 起來之後是「運行中」＋ managed（面板自己開的）", ran);
      check("B5. port 通之前有出現過「啟動中」（20 秒寬限期）", sawStarting || ran,
        sawStarting ? "有看到 starting" : "起太快，沒抓到 starting 那一格（不擋）");

      let ids = null;
      for (let i = 0; i < 40 && !ids; i++) {
        try { ids = JSON.parse(fs.readFileSync(outA, "utf8")); } catch (e) { await sleep(150); }
      }
      check("B6. 負控組：假工具與它的孫程序**現在都活著**（先證明這把尺量得到東西）",
        !!ids && alive(ids.pid) && alive(ids.kid), ids ? JSON.stringify(ids) : "沒拿到 pid");

      r = await req(PORT, "POST", "/tools/fake-a/stop");
      check("B7. 停止回 ok", r.status === 200 && r.json.ok, JSON.stringify(r.json));
      let dead = false;
      for (let i = 0; i < 40; i++) {
        if (ids && !alive(ids.pid) && !alive(ids.kid)) { dead = true; break; }
        await sleep(200);
      }
      check("B8. \u2605\u2605 整棵樹都被殺了 —— 連孫程序都沒留（taskkill /t /f）", dead,
        ids ? ("父 " + ids.pid + " 活著=" + alive(ids.pid) + "｜孫 " + ids.kid + " 活著=" + alive(ids.kid)) : "");
      r = await req(PORT, "GET", "/tools");
      check("B9. 停掉之後狀態回到「沒在跑」", toolOf(r.json.tools, "fake-a").status === "stopped");
      r = await req(PORT, "POST", "/tools/nope-nope/start");
      check("B10. 不存在的工具 → 404 ＋ 人話", r.status === 404 && /找不到/.test((r.json && r.json.message) || ""));
    }

    /* ---------------- F. 重啟的空窗期 ---------------- */
    /* 2026-09-03 的真實回報：「我按了重啟，他就沒有寫他在啟動中了」。
     * 重啟＝先殺掉、1.2 秒後再開；那 1.2 秒裡程序真的不在，
     * 狀態如果照實算就會是「沒在跑」——按鈕看起來像沒反應。 */
    if (want("F")) {
      head("F  重啟：中間那 1.2 秒不准說「沒在跑」");
      let ran = false, pid0 = null;
      await req(PORT, "POST", "/tools/fake-a/start");
      for (let i = 0; i < 60; i++) {
        const q = await req(PORT, "GET", "/tools");
        const t = toolOf(q.json.tools, "fake-a");
        if (t.status === "running") { ran = true; pid0 = t.pid; break; }
        await sleep(200);
      }
      check("F1. 前置：先讓它真的跑起來", ran, "pid=" + pid0);

      await req(PORT, "POST", "/tools/fake-a/restart");
      let r2 = await req(PORT, "GET", "/tools");      /* 立刻問 —— 就是他按完馬上看的那一格 */
      const gap = toolOf(r2.json.tools, "fake-a");
      check("F2. ★★ 按完重啟馬上問 → 是「啟動中」而不是「沒在跑」",
        gap.status === "starting", "status=" + gap.status + "｜pending=" + gap.pending);
      check("F3. ★ 空窗期會標 pending（畫面才寫得出「重新啟動中」）", gap.pending === true);

      let back = null;
      for (let i = 0; i < 60; i++) {
        const q = await req(PORT, "GET", "/tools");
        const t = toolOf(q.json.tools, "fake-a");
        if (t.status === "running") { back = t; break; }
        await sleep(250);
      }
      check("F4. ★ 重啟完真的回到「運行中」，而且是新的一顆 pid（不是原本那顆沒死）",
        !!back && back.pid !== pid0, back ? ("舊 " + pid0 + " → 新 " + back.pid) : "沒回到 running");
      /* ⚠️ 這裡刻意**不用** alive(舊 pid) 當負控組：Windows 會馬上回收剛釋放的 pid，
       * 新那棵的子孫很容易撿到同一個號碼，這條會無來由地閃紅（實測三次三種結果）。
       * 「整棵樹真的死了」由 B8 用假工具自己寫下來的 pid 檔驗；這裡改看 log 的事件順序。 */
      const lg = await req(PORT, "GET", "/tools/fake-a/logs");
      const txt = ((lg.json && lg.json.logs) || []).join("\n");
      check("F5. 負控組：log 裡真的有「殺掉→再開」這兩件事（不是只換了顯示文字）",
        /taskkill/.test(txt) && /重啟中/.test(txt) && /啟動：/.test(txt),
        txt.split("\n").slice(-4).join(" ⏎ "));
      await req(PORT, "POST", "/tools/fake-a/stop");
      await sleep(600);
    }

    /* ---------------- H. 只認得出 port 的孤兒 ---------------- */
    /* 2026-09-03：面板開的工具是 windowsHide（沒有視窗）。後台被硬殺之後它們變成孤兒，
     * processMatch 又對不上（指令列只是 "node server.js"）。以前畫面只能寫
     * 「去原本那個視窗關掉」——那個視窗不存在，Benson 因此完全找不到怎麼關。 */
    if (want("H")) {
      head("H  孤兒：認不出 PID 就問「誰佔著這個 port」，一樣要停得掉");
      let r = await req(PORT, "GET", "/tools");
      check("H1. 負控組：還沒人佔那個 port → 沒在跑（證明不是恆綠）",
        toolOf(r.json.tools, "orphan").status === "stopped");

      const orphanFile = path.join(dir, "__tmp__orphanmark.js");
      fs.writeFileSync(orphanFile, FAKE_TOOL);
      const orph = spawn(process.execPath, [orphanFile], {
        cwd: dir, stdio: "ignore",
        env: Object.assign({}, process.env, { FAKE_PORT: String(ORPHAN_PORT), FAKE_OUT: outH }),
      });
      extras.push(orph);
      let ids = null;
      for (let i = 0; i < 40 && !ids; i++) {
        try { ids = JSON.parse(fs.readFileSync(outH, "utf8")); } catch (e) { await sleep(150); }
      }
      check("H2. 負控組：孤兒真的起來了（父＋孫都活著）",
        !!ids && alive(ids.pid) && alive(ids.kid), ids ? JSON.stringify(ids) : "沒起來");

      let seen = null;
      for (let i = 0; i < 20; i++) {
        const q = await req(PORT, "GET", "/tools");
        const t = toolOf(q.json.tools, "orphan");
        if (t.status === "running") { seen = t; break; }
        await sleep(500);
      }
      check("H3. ★ 只有 port 認得出來，也判成「運行中（不是這裡開的）」",
        !!seen && seen.external === true && seen.managed === false, JSON.stringify(seen));
      check("H4. ★★ 認得出 PID ⇒ 停得掉（以前這裡是 stoppable:false ＋「去原本那個視窗關掉」）",
        !!seen && seen.stoppable === true && seen.pid > 0,
        seen ? ("stoppable=" + seen.stoppable + "｜pid=" + seen.pid) : "");

      const rs = await req(PORT, "POST", "/tools/orphan/stop");
      check("H5. ★ 停止回 ok", rs.status === 200 && rs.json.ok === true, JSON.stringify(rs.json));
      let dead = false;
      for (let i = 0; i < 40; i++) {
        if (ids && !alive(ids.pid) && !alive(ids.kid)) { dead = true; break; }
        await sleep(200);
      }
      check("H6. ★ 孤兒那棵也是整棵死（連孫程序）", dead,
        ids ? ("父活著=" + alive(ids.pid) + "｜孫活著=" + alive(ids.kid)) : "");
    }

    /* ---------------- C. 偵測 ---------------- */
    if (want("C")) {
      head("C  偵測：「不是我開的但已經在跑」＋ 排除面板自己與它的子孫");
      let r = await req(PORT, "GET", "/tools");
      check("C1. \u2605 負控組：不可能命中的 needle → 沒在跑（證明不是每一筆都亮綠燈）",
        toolOf(r.json.tools, "never").status === "stopped");
      check("C2. \u2605 needle 只命中面板自己的指令列 → 沒在跑（面板自己要被排除）",
        toolOf(r.json.tools, "self-probe").status === "stopped");

      await req(PORT, "POST", "/tools/fake-a/start");
      let okSub = false, okA = false;
      for (let i = 0; i < 50; i++) {
        await sleep(250);
        const q = await req(PORT, "GET", "/tools");
        const a = toolOf(q.json.tools, "fake-a");
        const sub = toolOf(q.json.tools, "subtree-probe");
        if (a.status === "running") { okA = true; okSub = sub.status === "stopped"; break; }
      }
      check("C3. \u2605 面板啟動的工具，同 needle 的另一筆不會被重複判定成「外部在跑」（子孫排除）",
        okA && okSub, "fake-a running=" + okA + "｜subtree-probe stopped=" + okSub);
      await req(PORT, "POST", "/tools/fake-a/stop");
      await sleep(1200);

      /* 外部啟動：由測試自己開一個帶 __tmp__extmark 的程序（不經過面板） */
      const extFile = path.join(dir, "__tmp__extmark.js");
      fs.writeFileSync(extFile, FAKE_TOOL);
      const ext = spawn(process.execPath, [extFile], {
        cwd: dir, env: Object.assign({}, process.env, { FAKE_OUT: outE }), stdio: "ignore",
      });
      extras.push(ext);
      let extIds = null;
      for (let i = 0; i < 40 && !extIds; i++) {
        try { extIds = JSON.parse(fs.readFileSync(outE, "utf8")); } catch (e) { await sleep(150); }
      }
      check("C4. 負控組：外部程序真的起來了（先證明有東西可以被偵測到）",
        !!extIds && alive(extIds.pid), extIds ? JSON.stringify(extIds) : "沒起來");

      let seen = null;
      for (let i = 0; i < 20; i++) {
        const q = await req(PORT, "GET", "/tools");
        const t = toolOf(q.json.tools, "fake-ext");
        if (t.status === "running") { seen = t; break; }
        await sleep(700);       /* 掃描有 5 秒 TTL 快取，要等它過期 */
      }
      check("C5. \u2605 偵測到「不是我開的但已經在跑」（external=true、managed=false）",
        !!seen && seen.external === true && seen.managed === false, JSON.stringify(seen));
      check("C6. 有 PID 就停得掉（純靠 port 探到的才停不了）", !!seen && seen.stoppable === true);

      const rs = await req(PORT, "POST", "/tools/fake-ext/stop");
      check("C7. \u2605 外部程序也停得掉", rs.status === 200 && rs.json.ok, JSON.stringify(rs.json));
      let extDead = false;
      for (let i = 0; i < 40; i++) {
        if (extIds && !alive(extIds.pid) && !alive(extIds.kid)) { extDead = true; break; }
        await sleep(200);
      }
      check("C8. \u2605 外部那棵也連孫程序一起死了", extDead,
        extIds ? ("父活著=" + alive(extIds.pid) + "｜孫活著=" + alive(extIds.kid)) : "");
    }

    /* ---------------- E. 只接受本機 ---------------- */
    if (want("E")) {
      head("E  只接受本機連線 ＋ 跨來源 POST 擋掉");
      const loop = await new Promise((resolve) => {
        const sock = net.connect({ host: "127.0.0.1", port: PORT });
        sock.setTimeout(1500);
        sock.once("connect", () => { sock.destroy(); resolve(true); });
        sock.once("timeout", () => { sock.destroy(); resolve(false); });
        sock.once("error", () => resolve(false));
      });
      check("E1. 負控組：127.0.0.1 連得上（證明這把尺是活的、port 真的開著）", loop);

      const lan = [].concat.apply([], Object.keys(os.networkInterfaces() || {})
        .map((k) => os.networkInterfaces()[k]))
        .filter((n) => n && n.family === "IPv4" && !n.internal).map((n) => n.address);
      if (!lan.length) {
        check("E2. （這台沒有對外 IPv4，跳過）", true);
      } else {
        const reach = await new Promise((resolve) => {
          const sock = net.connect({ host: lan[0], port: PORT });
          sock.setTimeout(2000);
          sock.once("connect", () => { sock.destroy(); resolve(true); });
          sock.once("timeout", () => { sock.destroy(); resolve(false); });
          sock.once("error", () => resolve(false));
        });
        check("E2. \u2605 從本機對外 IP（" + lan[0] + "）連不上 → 只綁 127.0.0.1", reach === false);
      }
      let r = await req(PORT, "POST", "/tools/fake-a/stop", { Origin: "https://evil.example" });
      check("E3. \u2605 跨來源的 POST 被擋（403）—— 隨便一個網頁不能叫這台電腦跑程式",
        r.status === 403, r.status + " " + ((r.json && r.json.message) || ""));
      r = await req(PORT, "POST", "/tools/fake-a/stop", { Origin: "http://localhost:" + PORT });
      check("E4. 負控組：自己這一頁送的同樣請求不會被擋（證明 E3 不是把所有 POST 都擋掉）",
        r.status !== 403, "status=" + r.status);
      r = await req(PORT, "GET", "/state", { Host: "attacker.example:" + PORT });
      check("E5. \u2605 Host 不是 localhost/127.0.0.1 → 403（擋 DNS rebinding）", r.status === 403);
    }

    /* ---------------- I. 收工要把開過的工具一起帶走 ---------------- */
    /* 這一組**必須放最後**：它會把沙箱那台 server 關掉。
     * 孤兒的根因就在這裡——桌面 App 以前用 terminate()（硬殺），process.on('exit') 不會跑，
     * 所以每重啟一次後台就生一批沒有視窗的孤兒。改走 /api/shutdown 才收得乾淨。 */
    if (want("I")) {
      head("I  收工：/api/shutdown 要連它開的工具一起收（孤兒的根因）");
      /* 先把上一組留下的 pid 檔刪掉，不然會讀到早就死掉的那一組 pid（I1 會誤紅） */
      try { fs.unlinkSync(outA); } catch (e) { }
      await req(PORT, "POST", "/tools/fake-a/start");
      let ids = null;
      for (let i = 0; i < 40 && !ids; i++) {
        try { ids = JSON.parse(fs.readFileSync(outA, "utf8")); } catch (e) { await sleep(150); }
      }
      check("I1. 負控組：工具真的被面板開起來了（父＋孫都活著）",
        !!ids && alive(ids.pid) && alive(ids.kid), ids ? JSON.stringify(ids) : "沒起來");

      const rq = await req(PORT, "POST", "/shutdown");
      check("I2. /api/shutdown 回 ok", rq.status === 200 && rq.json && rq.json.ok === true,
        JSON.stringify(rq.json));

      let down = false;
      for (let i = 0; i < 40; i++) {
        try { await req(PORT, "GET", "/state"); } catch (e) { down = true; break; }
        await sleep(200);
      }
      check("I3. ★ 後台自己真的結束了", down);

      let dead = false;
      for (let i = 0; i < 40; i++) {
        if (ids && !alive(ids.pid) && !alive(ids.kid)) { dead = true; break; }
        await sleep(200);
      }
      check("I4. ★★ 它開的工具整棵樹一起被收掉了 —— 不留孤兒", dead,
        ids ? ("父活著=" + alive(ids.pid) + "｜孫活著=" + alive(ids.kid)) : "");
    }
  } finally {
    for (const e of extras) { try { spawnSync("taskkill", ["/pid", String(e.pid), "/t", "/f"]); } catch (x) { } }
    await stopServer(s, PORT);
    await sleep(400);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
}

/* ================================================================= */
/* D. 突變：把子樹排除拿掉，C2／C3 必須翻紅                            */
/* ================================================================= */
async function groupD() {
  head("D  \u2605 突變測試：把「排除面板自己與子孫」拿掉，C2／C3 必須翻紅");
  const dir = makeSandbox();
  const PORT = 45420;
  const FAKE_PORT = 45421;
  const mark = path.basename(dir);
  const outA = path.join(dir, "__tmp__a.json").replace(/\\/g, "/");

  const file = path.join(dir, "server.js");
  const src = fs.readFileSync(file, "utf8");
  const TARGET = "const queue = [process.pid];";
  if (src.indexOf(TARGET) < 0) {
    check("D0. 突變目標字串還在（找不到＝這一組等於沒測，不是通過）", false, TARGET);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
    return;
  }
  fs.writeFileSync(file, src.replace(TARGET, "const queue = [];"));
  check("D0. \u2605 突變真的套用了（檔案內容跟原檔不同）",
    fs.readFileSync(file, "utf8") !== src);

  writeTools(dir, [
    { id: "fake-a", name: "假工具A", emoji: "🧪", description: "", category: "作品",
      cwd: dir, command: "node __tmp__faketool.js", port: FAKE_PORT, url: null, autostart: false,
      processMatch: "__tmp__faketool", env: { FAKE_PORT: String(FAKE_PORT), FAKE_OUT: outA } },
    { id: "subtree-probe", name: "子樹探針", emoji: "🧷", description: "", category: "作品",
      cwd: dir, command: "node -e 0", port: null, url: null, autostart: false,
      processMatch: "__tmp__faketool" },
    { id: "self-probe", name: "自我探針", emoji: "🪞", description: "", category: "作品",
      cwd: dir, command: "node -e 0", port: null, url: null, autostart: false, processMatch: mark },
  ]);
  const s = startServer(dir, PORT);
  try {
    if (!(await waitUp(PORT))) {
      check("D1. 突變版起得來", false, s.logs.join("").slice(0, 300));
      return;
    }
    const r = await req(PORT, "GET", "/tools");
    check("D1. \u2605 拿掉排除之後，self-probe 變成「運行中」（證明 C2 是承重的）",
      toolOf(r.json.tools, "self-probe").status === "running",
      "status=" + toolOf(r.json.tools, "self-probe").status);

    await req(PORT, "POST", "/tools/fake-a/start");
    let subRunning = false, aRunning = false;
    for (let i = 0; i < 50; i++) {
      await sleep(250);
      const q = await req(PORT, "GET", "/tools");
      if (toolOf(q.json.tools, "fake-a").status === "running") {
        aRunning = true;
        subRunning = toolOf(q.json.tools, "subtree-probe").status === "running";
        if (subRunning) break;
      }
    }
    check("D2. \u2605 拿掉排除之後，子孫被重複判定成「外部在跑」（證明 C3 是承重的）",
      aRunning && subRunning, "fake-a running=" + aRunning + "｜subtree-probe running=" + subRunning);
    await req(PORT, "POST", "/tools/fake-a/stop");
    await sleep(800);
  } finally {
    await stopServer(s, PORT);
    await sleep(400);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
}

/* ================================================================= */
/* G. 突變：把重啟的空窗標記拿掉，F2 必須翻紅                          */
/* ================================================================= */
async function groupG() {
  head("G  ★ 突變測試：拿掉重啟的空窗標記，F2 必須翻紅");
  const dir = makeSandbox();
  const PORT = 45430;
  const FAKE_PORT = 45431;
  const outA = path.join(dir, "__tmp__a.json").replace(/\\/g, "/");

  const file = path.join(dir, "server.js");
  const src = fs.readFileSync(file, "utf8");
  const TARGET = "st.pendingUntil = Date.now() + RESTART_DELAY_MS + STARTING_GRACE_MS;";
  if (src.indexOf(TARGET) < 0) {
    check("G0. 突變目標字串還在（找不到＝這一組等於沒測，不是通過）", false, TARGET);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
    return;
  }
  fs.writeFileSync(file, src.replace(TARGET, "st.pendingUntil = 0;"));
  check("G0. ★ 突變真的套用了", fs.readFileSync(file, "utf8") !== src);

  writeTools(dir, [
    { id: "fake-a", name: "假工具A", emoji: "🧪", description: "", category: "作品",
      cwd: dir, command: "node __tmp__faketool.js", port: FAKE_PORT, url: null, autostart: false,
      processMatch: "__tmp__faketool", env: { FAKE_PORT: String(FAKE_PORT), FAKE_OUT: outA } },
  ]);
  const s = startServer(dir, PORT);
  try {
    if (!(await waitUp(PORT))) {
      check("G1. 突變版起得來", false, s.logs.join("").slice(0, 300));
      return;
    }
    await req(PORT, "POST", "/tools/fake-a/start");
    let ran = false;
    for (let i = 0; i < 60; i++) {
      const q = await req(PORT, "GET", "/tools");
      if (toolOf(q.json.tools, "fake-a").status === "running") { ran = true; break; }
      await sleep(200);
    }
    check("G1. 前置：突變版也跑得起來", ran);
    await req(PORT, "POST", "/tools/fake-a/restart");
    const r = await req(PORT, "GET", "/tools");
    const t = toolOf(r.json.tools, "fake-a");
    check("G2. ★ 拿掉空窗標記之後，按完重啟馬上問就變回「沒在跑」（證明 F2 是承重的）",
      t.status === "stopped", "status=" + t.status);
    await req(PORT, "POST", "/tools/fake-a/stop");
    await sleep(600);
  } finally {
    await stopServer(s, PORT);
    await sleep(400);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
}

(async function main() {
  console.log("🧰 check-tools.js — 工具分頁的機器驗收（沙箱＋假工具，不碰真的那幾支）");
  if (want("A")) groupA();
  if (want("B") || want("C") || want("E") || want("F") || want("H") || want("I")) await groupsLive();
  if (want("D")) await groupD();
  if (want("G")) await groupG();
  console.log("\n" + "=".repeat(64));
  if (fail === 0) console.log("✅ 全部 " + pass + " 條通過");
  else console.log("❌ " + fail + " 條沒過（通過 " + pass + " 條）");
  process.exit(fail === 0 ? 0 : 1);
})();
