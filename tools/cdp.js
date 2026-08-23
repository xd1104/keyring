"use strict";
/*
 * cdp.js — 最小的 headless Chrome 驅動（零依賴，只用 Node 內建的 fetch ＋ WebSocket）
 *
 * 為什麼不是用 puppeteer：這台機器沒裝、也不想為了兩支檢查腳本引進 node_modules。
 * Node 22 已經有全域 WebSocket，Chrome 的 DevTools Protocol 本來就是 WebSocket ＋ JSON，
 * 直接講就好。
 *
 * ⚠️ 量動畫時序時**只信頁面自己的時鐘**（page.eval 裡的 performance.now()／animationstart），
 *    不要在 Node 這邊用 setTimeout 推算 —— 跨行程的計時會被排程延遲汙染。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && fs.existsSync(p)) return p;
  throw new Error("找不到 chrome.exe，請在 cdp.js 的 CHROME_CANDIDATES 加上路徑");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(opts) {
  opts = opts || {};
  const exe = findChrome();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kr-chrome-"));
  const args = [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--remote-debugging-port=0", "--user-data-dir=" + userDataDir,
    "--window-size=" + (opts.width || 375) + "," + (opts.height || 720),
    "about:blank"
  ];
  if (opts.reducedMotion) args.push("--force-prefers-reduced-motion");
  /* shell:false ＋ 正斜線路徑：繞開 cmd.exe 的 ENOENT（這台機器的老雷） */
  const proc = spawn(exe, args, { shell: false, stdio: "ignore" });

  const portFile = path.join(userDataDir, "DevToolsActivePort");
  let port = null;
  for (let i = 0; i < 100 && port === null; i++) {
    await sleep(100);
    try {
      const txt = fs.readFileSync(portFile, "utf8").split("\n");
      if (txt[0] && txt[0].trim()) port = Number(txt[0].trim());
    } catch (e) { /* 還沒寫出來 */ }
  }
  if (!port) { proc.kill(); throw new Error("Chrome 沒有寫出 DevToolsActivePort（啟動失敗）"); }

  const base = "http://127.0.0.1:" + port;
  const page = await newPage(base);
  return {
    page,
    async close() {
      try { page.ws.close(); } catch (e) { }
      try { proc.kill(); } catch (e) { }
      await sleep(150);
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { }
    }
  };
}

async function newPage(base) {
  const r = await fetch(base + "/json/new?about:blank", { method: "PUT" });
  const target = await r.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method) {
      listeners.forEach((fn) => fn(msg));
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await send("Page.enable");
  await send("Runtime.enable");

  const page = {
    ws, send,
    on(fn) { listeners.push(fn); },
    async goto(url) {
      const loaded = new Promise((res) => {
        const fn = (m) => { if (m.method === "Page.loadEventFired") { res(); } };
        listeners.push(fn);
      });
      await send("Page.navigate", { url });
      await loaded;
    },
    /* expr 可以是 async 函式的字串；回傳值一律走 JSON */
    async eval(expr) {
      const r = await send("Runtime.evaluate", {
        expression: "(async()=>{" + expr + "})()",
        awaitPromise: true, returnByValue: true
      });
      if (r.exceptionDetails) {
        throw new Error("頁面內錯誤：" + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      }
      return r.result.value;
    },
    async setViewport(width, height) {
      await send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 1, mobile: true
      });
    }
  };
  return page;
}

module.exports = { launch, sleep };
