"use strict";
/*
 * check-unlock.js — 解鎖模組（client/keyring-unlock.js）的機器驗收，可重跑。
 *
 *   node tools/check-unlock.js              全部跑一遍
 *   node tools/check-unlock.js --only=A,B   只跑指定幾項
 *   KR_CPU_THROTTLE=6 node tools/check-unlock.js   壓力模式：CPU 放慢 6 倍
 *
 * ⚠️ 這支是「以後每次改模組都要跑」的常設閘門，所以**它自己不可以飄**：
 *   會飄的閘門比沒有閘門更糟（紅燈變成雜訊之後，真的壞掉那一次就沒人信了）。
 *   規矩：**瞬間狀態一律事件驅動**（MutationObserver／animationstart／observer callback 裡當場量），
 *   絕不用「等 N 毫秒再看一眼」去抓只活幾百毫秒的東西（例如 kr-leave kr-up 只有 230ms、
 *   「✓ 解開了」只有 430ms、FLIP 的 inline transform 只有 400ms）。
 *   需要用時間當窗的地方（E11）就記**真正經過的時間**，不要用預定的取樣點。
 *   改完請用壓力模式連跑幾次確認。
 *
 * 每一條檢查都對應一條「壞過一次」的規則，不是為了好看：
 *   A 密度 class（.kr-short/.kr-tiny/.kr-micro）底下不得出現 animation／transition
 *     —— 那是全檔唯一會在元素活著時 add/remove 的 class（applyDensity），
 *        一旦掛了動畫，鍵盤一動就重播（DESIGN §4-7 的唯一例外與它的代價）。
 *   B #kr-full 子樹一個宿主變數都不准讀（連 var(--acc, fallback) 都不行）。
 *     ⚠️ **走 live CSSOM 不是 grep**：grep 會被註解、字串、被覆蓋掉的規則誤報。
 *        （CSSOM 只看得到「同一條規則裡最後生效的那個宣告」——被自己後面蓋掉的
 *          `color:var(--ink)` 不會被判違規，那是對的：它根本畫不出來。實測驗過。）
 *   C 公版的機器定義：同一份模組在三個宿主（travel／recipe／完全空白）computed style 逐項相同。
 *   D 每個可互動元素實際量 computed style（v2.0 那顆透明解鎖鈕就是這樣漏掉的）＋觸控目標 ≥44px。
 *   E 動畫四條路徑（開啟／換屏／同屏重繪／打錯／解鎖成功）不重播、時序正確。
 *     ⚠️ 全部用**頁面自己的時鐘**（performance.now／animationstart），不用外面的計時器。
 *   F 矮螢幕五階（500/440/407/380/340）最壞情境（理由條＋已打錯兩次）不被切。
 *   G 底部露白：--kr-vh 407 ＋ iOS 位移 46 時，層以外那圈是模組的 --krs-bleed 不是宿主底色。
 *     附**反向對照**（把修法關掉必須抓得到漏），證明這支探針不是恆綠。
 *   H prefers-reduced-motion：真的不播，而且藥丸最終看得見也點得到
 *     （.kr-chip.kr-chip{animation:none!important} 那條是承重的）。
 *
 * 全程用假 token（ghp_FAKE_…）跑真的 PBKDF2＋AES-GCM，真金鑰不進測試。
 */
const { launch, sleep } = require("./cdp");
const { serve } = require("./harness");
const png = require("./png");

const only = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const wants = (id) => !only.length || only.includes(id);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? "  ✅ " : "  ❌ ") + name + (detail ? "\n      " + detail : ""));
}
function head(t) { console.log("\n" + t); }

/* ---------- 頁面內共用的小工具（塞在每段 eval 前面） ---------- */
const PRE = `
const $ = (s) => document.querySelector(s);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const cs = (el, p, pseudo) => getComputedStyle(el, pseudo || null).getPropertyValue(p);
const sig = (el) => !el ? "?" : (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className ? "." + String(el.className).trim().split(/\\s+/).join(".") : ""));
const untilEl = async (sel, ms) => { const t0 = performance.now(); while (performance.now() - t0 < (ms || 4000)) { if ($(sel)) return $(sel); await wait(16); } return null; };
`;

async function gotoHost(page, base, host, users) {
  await page.goto(base + "/h/" + host + (users ? "?users=" + users : ""));
  await page.eval("await window.__ready; return true;");
}

/* ---------------- A / B：CSSOM 掃描 ---------------- */
const CSSOM_SCAN = PRE + `
const sheet = [...document.styleSheets].find(s => s.ownerNode && s.ownerNode.id === "kr-style");
if (!sheet) return { error: "找不到 #kr-style（樣式沒注入？）" };
const flat = [];
/* ⚠️ 新版 Chrome 的 CSSStyleRule 也有 .cssRules（巢狀語法用的，通常是空的）⇒
 * 不可以用「有沒有 cssRules」當「是不是群組規則」的判準，先看 selectorText。
 * @media 底下的規則要遞迴拆開才不會漏（實測 170 條裡有 18 條在 @media 裡）。 */
(function walk(list, media) {
  for (const r of list) {
    if (r.selectorText) {
      flat.push({ sel: r.selectorText, media: media || "", style: r.style });
      if (r.cssRules && r.cssRules.length) walk(r.cssRules, media);
    } else if (r.cssRules) walk(r.cssRules, r.conditionText || media);
  }
})(sheet.cssRules, "");
const decls = (r) => { const out = []; for (let i = 0; i < r.style.length; i++) { const p = r.style[i]; out.push([p, r.style.getPropertyValue(p)]); } return out; };

/* A：密度 class 底下不准有 animation／transition */
let densityRules = 0; const densityBad = [];
for (const r of flat) {
  if (!/\\.kr-(short|tiny|micro)\\b/.test(r.sel)) continue;
  densityRules++;
  for (const [p, v] of decls(r)) if (/^(animation|transition)/.test(p)) densityBad.push(r.sel + " { " + p + ":" + v + " }");
}
/* B：#kr-full 子樹只准讀自己的 --krs-* / --kr-*，其他 var() 一律算宿主變數 */
let fullRules = 0; const varBad = []; const hostVarRe = /var\\(\\s*--(?!krs-|kr-)/;
for (const r of flat) {
  if (r.sel.indexOf("#kr-full") < 0) continue;
  fullRules++;
  for (const [p, v] of decls(r)) if (hostVarRe.test(v)) varBad.push(r.sel + " { " + p + ":" + v + " }");
}
/* 唯一被允許的宿主變數：藥丸的 .kr-cta 前景色 */
const accReads = [];
for (const r of flat) for (const [p, v] of decls(r)) if (/var\\(\\s*--acc\\b/.test(v)) accReads.push(r.sel + " { " + p + " }");
return { total: flat.length, densityRules, densityBad, fullRules, varBad, accReads };
`;

/* ---------------- C / D：computed style ---------------- */
const PROPS = ["background-color", "background-image", "color", "font-family", "font-size", "font-weight",
  "line-height", "letter-spacing", "text-align", "border-radius", "border-top-width", "border-top-color",
  "box-shadow", "opacity", "min-height", "width", "height", "padding-top", "padding-left", "margin-top",
  "white-space", "-webkit-text-size-adjust", "animation-name", "transition-property"];
const SNAP = (sels) => `
const SEL = ${JSON.stringify(sels)}, PROPS = ${JSON.stringify(PROPS)};
const out = {};
for (const s of SEL) {
  const el = $(s);
  if (!el) { out[s] = null; continue; }
  const o = {};
  for (const p of PROPS) o[p] = cs(el, p);
  out[s] = o;
}
return out;
`;

async function run() {
  const srv = await serve();
  const base = "http://127.0.0.1:" + srv.port;
  const b = await launch({ width: 375, height: 720 });
  const page = b.page;
  await page.setViewport(375, 720);
  /* 壓力模式：故意讓主執行緒變慢，用來驗「這些檢查抓的是事件不是時間點」 */
  const throttle = Number(process.env.KR_CPU_THROTTLE || 0);
  if (throttle > 1) {
    await page.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    console.log("（壓力模式：CPU 放慢 " + throttle + " 倍）");
  }

  try {
    /* ---------- A / B ---------- */
    if (wants("A") || wants("B")) {
      head("A/B  CSSOM 掃描（密度 class 無動畫、#kr-full 不讀宿主變數）");
      await gotoHost(page, base, "travel", 3);
      await page.eval(PRE + "Keyring.open(''); await wait(60); return true;");
      const r = await page.eval(CSSOM_SCAN);
      if (r.error) { check("CSSOM 掃描", false, r.error); }
      else {
        if (wants("A")) check("A. 密度 class 底下 0 條 animation／transition（掃 " + r.densityRules + " 條規則）",
          r.densityBad.length === 0, r.densityBad.join("\n      "));
        if (wants("B")) {
          check("B. #kr-full 子樹讀宿主變數 = 0（掃描總量 " + r.total + " 條，命中 #kr-full 的 " + r.fullRules + " 條）",
            r.varBad.length === 0, r.varBad.join("\n      "));
          check("B2. 全檔 --acc 只出現一次，且在藥丸前景（.kr-cta 的 color）",
            r.accReads.length === 1 && /kr-cta/.test(r.accReads[0]) && /color/.test(r.accReads[0]),
            r.accReads.join(" / "));
        }
      }
    }

    /* ---------- C：三宿主逐項相同 ---------- */
    if (wants("C")) {
      head("C  公版：travel／recipe／空白頁 computed style 逐項相同");
      const whoSels = ["#kr-full", "#kr-full .kr-top", "#kr-full .kr-app", "#kr-full .kr-x", "#kr-full .kr-main",
        "#kr-full .kr-mid", "#kr-full .kr-wrap", "#kr-full .kr-h", "#kr-full .kr-sub", "#kr-full .kr-why",
        "#kr-full .kr-grid", "#kr-full .kr-tile", "#kr-full .kr-av", "#kr-full .kr-nm",
        "#kr-full .kr-foot", "#kr-full .kr-peek", "#kr-full .kr-peek b", ".kr-chip"];
      /* ⚠️ `.kr-chip .kr-cta` 的 color 刻意**不**進逐項相同的母體：那是全模組唯一
       * 允許跟著宿主走的鉤子（--acc）。它反而要「三個宿主各不相同」才算對，見 C2。 */
      const pwSels = ["#kr-full .kr-id", "#kr-full .kr-id b", "#kr-full .kr-id div span", "#kr-full .kr-field",
        "#kr-full #kr-pw", "#kr-full .kr-eye", "#kr-full .kr-check", "#kr-full .kr-box", "#kr-full .kr-lb",
        "#kr-full .kr-go", "#kr-full .kr-back"];
      const snaps = {};
      for (const host of ["travel", "recipe", "blank"]) {
        await gotoHost(page, base, host, 3);
        /* 動畫會讓 opacity/transform 在飛，量之前先讓它們跑完（是快轉，不是關掉） */
        const s1 = await page.eval(PRE + "Keyring.open('規劃新旅程'); await wait(80);"
          + "document.getAnimations().forEach(a=>a.finish());" + SNAP(whoSels));
        const s2 = await page.eval(PRE + "document.querySelectorAll('#kr-full .kr-tile')[1].click(); await wait(80);"
          + "document.getAnimations().forEach(a=>a.finish());" + SNAP(pwSels));
        snaps[host] = Object.assign({}, s1, s2);
      }
      const sels = Object.keys(snaps.travel);
      const diffs = []; let cells = 0; const missing = [];
      for (const s of sels) {
        const a = snaps.travel[s], b2 = snaps.recipe[s], c = snaps.blank[s];
        if (!a || !b2 || !c) { missing.push(s); continue; }
        for (const p of PROPS) {
          cells++;
          if (a[p] !== b2[p] || a[p] !== c[p]) diffs.push(s + " { " + p + " } travel=" + a[p] + " / recipe=" + b2[p] + " / blank=" + c[p]);
        }
      }
      check("C. " + sels.length + " 個元素 × " + PROPS.length + " 個屬性 = " + cells + " 項，三宿主逐項相同",
        diffs.length === 0 && missing.length === 0,
        diffs.slice(0, 12).join("\n      ") + (missing.length ? "\n      量不到的元素：" + missing.join(",") : ""));
      /* 反過來驗那個唯一的鉤子真的還活著：底色三家相同、只有 CTA 前景跟著 --acc 走 */
      const cta = {}; const chipBg = {};
      for (const host of ["travel", "recipe", "blank"]) {
        await gotoHost(page, base, host, 3);
        const r = await page.eval(PRE + "return { c: cs($('.kr-chip .kr-cta'), 'color'), b: cs($('.kr-chip'), 'background-color') };");
        cta[host] = r.c; chipBg[host] = r.b;
      }
      check("C2. 唯一的鉤子：藥丸底色三家相同，只有 .kr-cta 前景吃各家 --acc（沒設就用模組預設）",
        chipBg.travel === chipBg.recipe && chipBg.travel === chipBg.blank
        && cta.travel !== cta.recipe && cta.blank === "rgb(193, 85, 63)",
        "底色 " + chipBg.blank + "；前景 travel=" + cta.travel + " recipe=" + cta.recipe + " blank(預設)=" + cta.blank);
    }

    /* ---------- D：可互動元素的實際樣式與觸控目標 ---------- */
    if (wants("D")) {
      head("D  可互動元素 computed style ＋ 觸控目標 ≥44px");
      await gotoHost(page, base, "travel", 3);
      const d = await page.eval(PRE + `
        Keyring.open(''); await wait(60);
        const tiles = document.querySelectorAll('#kr-full .kr-tile');
        const tileH = tiles[0].getBoundingClientRect().height;
        const xR = $('#kr-full .kr-x').getBoundingClientRect();
        const peekR = $('#kr-full .kr-peek').getBoundingClientRect();
        const chipR = $('.kr-chip').getBoundingClientRect();
        const chipBg = cs($('.kr-chip'), 'background-color');
        tiles[1].click(); await wait(60);
        document.getAnimations().forEach(a => a.finish());
        const go = $('#kr-full .kr-go'), pw = $('#kr-full #kr-pw'), eye = $('#kr-full .kr-eye');
        const box = $('#kr-full .kr-box'), chk = $('#kr-full .kr-check'), back = $('#kr-full .kr-back');
        return {
          goBg: cs(go, 'background-color'), goImg: cs(go, 'background-image').slice(0, 40),
          goH: go.getBoundingClientRect().height, chipBg,
          pwFont: cs(pw, 'font-size'), pwH: pw.getBoundingClientRect().height,
          eye: eye.getBoundingClientRect().height, box: box.getBoundingClientRect().height,
          chk: chk.getBoundingClientRect().height, back: back.getBoundingClientRect().height,
          x: Math.min(xR.width, xR.height), peek: peekR.height, tile: tileH, chip: chipR.height,
          footPos: cs($('#kr-full .kr-foot'), 'position'),
          footFlex: cs($('#kr-full .kr-foot'), 'flex-grow'), footShrink: cs($('#kr-full .kr-foot'), 'flex-shrink'),
          footGap: Math.round($('#kr-full').getBoundingClientRect().bottom - $('#kr-full .kr-foot').getBoundingClientRect().bottom),
          footAtBottom: Math.abs($('#kr-full').getBoundingClientRect().bottom - $('#kr-full .kr-foot').getBoundingClientRect().bottom) < 1
        };
      `);
      check("D1. .kr-go 的 background-color = rgb(246, 239, 225)（不是 transparent）", d.goBg === "rgb(246, 239, 225)", "實際 " + d.goBg);
      check("D2. .kr-go 有 sheen（background-image 是漸層，且沒把底色吃掉）", /gradient/.test(d.goImg), d.goImg);
      check("D3. .kr-chip 的 background-color = rgb(246, 242, 234)", d.chipBg === "rgb(246, 242, 234)", "實際 " + d.chipBg);
      check("D4. #kr-pw 的 font-size = 16px（iOS 才不會自動放大）", d.pwFont === "16px", "實際 " + d.pwFont);
      const targets = { "✕": d.x, "👁": d.eye, "換一個人": d.back, "先看看就好": d.peek, "人物磚": d.tile, "藥丸": d.chip, "勾選列": d.chk, "解鎖鈕": d.goH, "密碼欄": d.pwH };
      const small = Object.keys(targets).filter(k => targets[k] < 44);
      check("D5. 觸控目標全部 ≥44px", small.length === 0,
        Object.keys(targets).map(k => k + "=" + Math.round(targets[k])).join(" / "));
      check("D6. .kr-foot 仍是 flex item：position 不是 fixed（relative 是本來就有的，給 z-index 用）、"
        + "flex 0 0 auto、底邊貼著層底 ⇒ 鍵盤彈出時自然停在鍵盤正上方",
        d.footPos !== "fixed" && d.footPos !== "absolute" && d.footFlex === "0" && d.footShrink === "0" && d.footAtBottom,
        "position=" + d.footPos + " flex-grow=" + d.footFlex + " flex-shrink=" + d.footShrink + " 底邊差=" + d.footGap + "px");
    }

    /* ---------- E：動畫路徑 ---------- */
    if (wants("E") || wants("F")) {
      head("E  動畫路徑（頁面自己的時鐘：performance.now ＋ animationstart）");
      await gotoHost(page, base, "blank", 3);
      const e = await page.eval(PRE + `
        window.__anim = []; window.__cls = []; window.__chipNodes = 0;
        document.addEventListener('animationstart', (ev) => {
          window.__anim.push({ t: Math.round(performance.now()), el: sig(ev.target), name: ev.animationName });
        }, true);
        new MutationObserver(ms => ms.forEach(m => {
          if (m.target.id === 'kr-full') window.__cls.push({ t: Math.round(performance.now()), v: m.target.className });
        })).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
        new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
          if (n.classList && n.classList.contains('kr-chip')) window.__chipNodes++;
        }))).observe($('#chipHost'), { childList: true });

        const log = {};
        /* ① 開啟：整套進場 */
        Keyring.open('規劃新旅程'); await wait(70);
        const L = $('#kr-full');
        log.open = { cls: [...L.classList].join(' '), layerAnim: cs(L, 'animation-name'),
          tile1Delay: cs(document.querySelectorAll('.kr-tile')[1], 'animation-delay'),
          tile1Name: cs(document.querySelectorAll('.kr-tile')[1], 'animation-name'),
          footName: cs($('.kr-foot'), 'animation-name') };
        await wait(700);

        /* ② 換屏＋頭像形變：.kr-id 從頭到尾不可以重播 */
        window.__anim.length = 0; window.__cls.length = 0;
        /* ⚠️ FLIP 的 inline transform 只活 400ms（runMorph 收尾會清掉）＝**瞬間狀態**，
         * 不可以用定點取樣去抓（主執行緒抖一下就錯過 ⇒ 會飄的紅線）。
         * 改成事件驅動：只要有任何 .kr-av 被寫過 transform 就記下來。 */
        let morphSeen = false;
        const moStyle = new MutationObserver(ms => ms.forEach(m => {
          const t = m.target;
          if (m.attributeName === 'style' && t.classList && t.classList.contains('kr-av')
            && (t.getAttribute('style') || '').indexOf('transform') >= 0) morphSeen = true;
        }));
        moStyle.observe(L, { subtree: true, attributes: true, attributeFilter: ['style'] });
        const t0 = performance.now();
        document.querySelectorAll('.kr-tile')[1].click();
        await wait(20);
        const idEl = $('.kr-id');
        log.step = { cls: [...L.classList].join(' '), nofx: idEl.classList.contains('kr-nofx'),
          idAnim: cs(idEl, 'animation-name'),
          avTransform: morphSeen ? 'inline' : 'none',
          samples: [] };
        for (const dt of [40, 120, 200, 300, 360, 395, 410, 425, 450, 520, 700]) {
          while (performance.now() - t0 < dt) await wait(4);
          const el = $('.kr-id');
          log.step.samples.push({ dt, o: cs(el, 'opacity'), an: cs(el, 'animation-name'), tr: cs(el, 'transform') });
        }
        log.step.idReplays = window.__anim.filter(a => /kr-id/.test(a.el) && a.t - Math.round(t0) > 30);
        log.step.clsChanges = window.__cls.map(c => c.v);
        /* 等到「收尾真的做完」為止，而不是假設 700ms 一定夠（CPU 慢的時候 rAF 會遲到）。
         * 要驗的是兩件事：inline style 有被清掉、而且清的過程沒有碰到 class（碰了就會重播）。 */
        const cleanFrom = performance.now();
        while ((($('.kr-id .kr-av').getAttribute('style') || '').indexOf('transform') >= 0)
          && performance.now() - cleanFrom < 3000) await wait(16);
        log.step.avInlineAfter = ($('.kr-id .kr-av').getAttribute('style') || '').indexOf('transform') >= 0;
        log.step.cleanAt = Math.round(performance.now() - t0);
        moStyle.disconnect();
        const animBefore = window.__anim.length;
        await wait(250);
        log.step.replayAfterCleanup = window.__anim.slice(animBefore).filter(a => /kr-id/.test(a.el)).length;
        log.step.clsChangesAfterCleanup = window.__cls.length;

        /* ③ 同一屏重繪（按顯示密碼）：完全不動 */
        window.__anim.length = 0;
        $('.kr-eye').click(); await wait(300);
        log.redraw = { cls: [...L.classList].join(' '), anims: window.__anim.slice(),
          tickAnim: cs($('.kr-box'), 'animation-name', '::after') };
        for (let i = 0; i < 4; i++) { $('.kr-eye').click(); await wait(120); }
        log.redraw.tickAfter5 = cs($('.kr-box'), 'animation-name', '::after');
        /* 勾選框預設就是打勾的 ⇒ 使用者「動到它」是先取消再勾回來；
         * ::after 只有在 :checked 時存在，所以要在「勾回來」之後才量得到 kr-tick。 */
        $('#kr-remember').click(); await wait(60);
        log.redraw.tickUnchecked = cs($('.kr-box'), 'animation-name', '::after');
        $('#kr-remember').click(); await wait(60);
        log.redraw.tickUserClicked = cs($('.kr-box'), 'animation-name', '::after');
        $('.kr-eye').click(); await wait(120);
        log.redraw.tickAfterRepaint = cs($('.kr-box'), 'animation-name', '::after');

        /* ④ 打錯密碼：抖一次，重繪不再抖 */
        $('#kr-pw').value = 'wrong-pw';
        $('#kr-full form').requestSubmit();
        await untilEl('.kr-err', 8000); await wait(30);
        log.wrong = { shake: $('.kr-field').classList.contains('kr-shake'),
          anim: cs($('.kr-field'), 'animation-name'), errAnim: cs($('.kr-err'), 'animation-name'),
          cls: [...L.classList].join(' ') };
        await wait(400);
        $('.kr-eye').click(); await wait(60);
        log.wrong.afterRedraw = cs($('.kr-field'), 'animation-name');
        /* 再錯一次 ⇒ tries=2（F 用得到），錯誤條會多出第二行說明 */
        $('#kr-pw').value = 'wrong-again';
        $('#kr-full form').requestSubmit();
        await untilEl('.kr-err span', 8000);
        log.wrong.twoLines = !!$('.kr-err span');
        return log;
      `);
      if (wants("E")) {
        check("E1. 開啟＝整套進場（kr-a-open、第 2 顆磚 delay .122s ＝ .09+1×.032）",
          /kr-a-open/.test(e.open.cls) && e.open.tile1Delay === "0.122s" && e.open.tile1Name === "kr-pop" && e.open.footName === "kr-rise",
          "class=" + e.open.cls + " / 磚 delay=" + e.open.tile1Delay + " / foot=" + e.open.footName);
        check("E2. 換屏＝kr-a-step、.kr-id 掛到 kr-nofx、頭像有 inline transform（FLIP）",
          /kr-a-step/.test(e.step.cls) && e.step.nofx && e.step.idAnim === "none" && e.step.avTransform === "inline",
          "class=" + e.step.cls + " / nofx=" + e.step.nofx + " / .kr-id animation=" + e.step.idAnim);
        const bad = e.step.samples.filter(s => s.o !== "1" || s.an !== "none");
        check("E3. 換屏後 11 個取樣點（含 395/410/425/450ms 那個舊重播窗）.kr-id 全程 opacity=1、animation=none",
          bad.length === 0 && e.step.idReplays.length === 0,
          "重播事件 " + e.step.idReplays.length + " 次；異常取樣 " + JSON.stringify(bad).slice(0, 200)
          + "；容器 class 變動：" + JSON.stringify(e.step.clsChanges));
        check("E4. runMorph 收尾只清 inline style、不碰 class（清完之後 .kr-id 沒有任何重播）",
          e.step.avInlineAfter === false && e.step.replayAfterCleanup === 0,
          "inline transform 在 " + e.step.cleanAt + "ms 清掉；收尾後 .kr-id 重播 "
          + e.step.replayAfterCleanup + " 次；期間容器 class 變動 " + e.step.clsChangesAfterCleanup + " 次");
        check("E5. 同一屏重繪（顯示密碼）容器 class 為空、0 個動畫起播",
          e.redraw.cls.replace(/kr-(short|tiny|micro)/g, "").trim() === "" && e.redraw.anims.length === 0,
          "class=[" + e.redraw.cls + "] / 起播 " + JSON.stringify(e.redraw.anims).slice(0, 200));
        check("E6. 打勾一次性：重繪 5 次都是 none，使用者按過才是 kr-tick，再重繪又回 none",
          e.redraw.tickAnim === "none" && e.redraw.tickAfter5 === "none"
          && e.redraw.tickUserClicked === "kr-tick" && e.redraw.tickAfterRepaint === "none",
          [e.redraw.tickAnim, e.redraw.tickAfter5, e.redraw.tickUserClicked, e.redraw.tickAfterRepaint].join(" → "));
        check("E7. 打錯密碼抖一次（kr-nudge）、錯誤條自己 kr-rise、容器不重跑進場",
          e.wrong.shake && e.wrong.anim === "kr-nudge" && e.wrong.errAnim === "kr-rise"
          && e.wrong.cls.replace(/kr-(short|tiny|micro)/g, "").trim() === "",
          "shake=" + e.wrong.shake + " / field=" + e.wrong.anim + " / err=" + e.wrong.errAnim + " / class=[" + e.wrong.cls + "]");
        check("E8. 之後按顯示密碼重繪不再抖（旗標被消費掉）", e.wrong.afterRedraw === "none", "animation=" + e.wrong.afterRedraw);
      }

      /* ---------- F：矮螢幕五階（沿用上面已經打錯兩次的狀態） ---------- */
      if (wants("F")) {
        head("F  --kr-vh 五階（最壞情境：理由條 ＋ 已打錯兩次）");
        for (const h of [500, 440, 407, 380, 340]) {
          await page.setViewport(375, h);
          await sleep(150);
          const r = await page.eval(PRE + `
            /* 等 fitVH 真的跟上這次的視窗高度，不要用「睡 N 毫秒」賭它跑完了 */
            const t0 = performance.now();
            while (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--kr-vh')) !== innerHeight
              && performance.now() - t0 < 3000) await wait(16);
            document.getAnimations().forEach(a => a.finish());
            const L = $('#kr-full'), vh = innerHeight;
            const must = { '身分列': '.kr-id', '密碼欄': '#kr-pw', '錯誤條': '.kr-err', '勾選': '.kr-check',
                           '解鎖鈕': '.kr-go', '先看看就好': '.kr-peek', '頂欄': '.kr-top' };
            const out = { vh, layerH: Math.round(L.getBoundingClientRect().height),
              density: [...L.classList].filter(c => /kr-(short|tiny|micro)/.test(c)).join(','), clipped: [], missing: [] };
            for (const k in must) {
              const el = $(must[k]);
              if (!el) { out.missing.push(k); continue; }
              const r2 = el.getBoundingClientRect();
              if (r2.top < -0.5 || r2.bottom > vh + 0.5) out.clipped.push(k + '(' + Math.round(r2.top) + '~' + Math.round(r2.bottom) + ')');
            }
            out.krvh = getComputedStyle(document.documentElement).getPropertyValue('--kr-vh').trim();
            return out;
          `);
          check("F. " + h + "px：主鈕／密碼欄／出口都沒被切",
            r.clipped.length === 0 && r.layerH === h && r.missing.length === 0,
            "層高 " + r.layerH + "（--kr-vh " + r.krvh + "）密度[" + (r.density || "-") + "] "
            + (r.clipped.length ? "被切:" + r.clipped.join(",") : "全部在畫面內")
            + (r.missing.length ? " 缺:" + r.missing.join(",") : ""));
        }
        await page.setViewport(375, 720);
        await sleep(120);
      }

      /* ---------- E9~E15：解鎖成功三拍 ---------- */
      if (wants("E")) {
        head("E(成功路徑)  三拍：✓ 解開了 → 退場 → 藥丸落點");
        const s = await page.eval(PRE + `
          window.__anim.length = 0; window.__chipNodes = 0;
          const L = $('#kr-full');
          /* ⚠️ 這條路徑上有兩個**只存在幾百毫秒**的狀態：第一拍的「✓ 解開了」（430ms）與
           * 退場的 「kr-leave kr-up」（230ms）。用定點取樣抓它們＝擲骰子，主執行緒忙一下就漏；
           * 會飄的閘門比沒有閘門更糟（紅燈變雜訊之後，真的壞掉那次沒人信）。兩個都改事件驅動：
           *   ・class：MutationObserver 把**出現過的每一個值**都留下來，斷言「曾經出現過」；
           *   ・第一拍的 computed style：在 observer 的 callback（microtask）裡當場量 ——
           *     microtask 一定跑在 430ms 那個 macrotask 之前，再忙也不會漏。 */
          const clsTrail = [];
          const clsMo = new MutationObserver(ms => ms.forEach(m => {
            if (m.target.id === 'kr-full') clsTrail.push(m.target.className);
          }));
          clsMo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
          const t0 = performance.now();
          let beat1 = null;
          const doneMo = new MutationObserver(() => {
            if (beat1) return;
            const g = $('#kr-full .kr-go.kr-ok');
            if (!g) return;
            const av = $('#kr-full .kr-av.kr-ok');
            beat1 = { t: Math.round(performance.now() - t0), go: g.textContent.trim(),
              goOpacity: cs(g, 'opacity'), goAnim: cs(g, 'animation-name'),
              ring: av ? cs(av, 'animation-name', '::after') : null,
              unlockedNow: Keyring.isUnlocked() };
          });
          doneMo.observe(L, { childList: true, subtree: true });
          $('#kr-pw').value = 'pw-1';
          $('#kr-full form').requestSubmit();
          await untilEl('.kr-go.kr-ok', 8000);   /* 只是等，量到的東西不靠這一刻 */
          const outStart = await new Promise(res => {
            const h = (ev) => { if (ev.animationName === 'kr-out') { document.removeEventListener('animationstart', h, true); res(performance.now()); } };
            document.addEventListener('animationstart', h, true);
            setTimeout(() => res(null), 3000);
          });
          const beat2 = { started: outStart !== null, scan: [] };
          for (const dt of [20, 60, 110, 160, 200, 235]) {
            while (performance.now() - outStart < dt) await wait(4);
            const c = $('.kr-chip');
            const r = c ? c.getBoundingClientRect() : null;
            const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
            /* at ＝**真正**過了多久（不是我本來想取樣的 dt）：主執行緒卡住時兩者會差很多，
             * 拿 dt 當判準會把「取樣遲到」誤判成「程式壞掉」。 */
            beat2.scan.push({ dt, at: Math.round(performance.now() - outStart),
              txt: c ? c.textContent.trim() : null, o: c ? cs(c, 'opacity') : null,
              pe: c ? cs(c, 'pointer-events') : null, hit: sig(hit), layerHidden: L.hidden });
          }
          await wait(150);
          clsMo.disconnect(); doneMo.disconnect();
          beat2.clsTrail = clsTrail;
          beat2.sawLeaveUp = clsTrail.some(v => /kr-leave/.test(v) && /kr-up/.test(v));
          const chip = $('.kr-chip');
          const beat3 = { layerHidden: L.hidden, layerCls: L.className, chipNodes: window.__chipNodes,
            anim: cs(chip, 'animation-name'), delay: cs(chip, 'animation-delay'), fill: cs(chip, 'animation-fill-mode'),
            hasNew: chip.classList.contains('kr-new') };
          chip.getAnimations().forEach(a => a.finish());
          await wait(30);
          const r2 = chip.getBoundingClientRect();
          beat3.after = { o: cs(chip, 'opacity'), pe: cs(chip, 'pointer-events'), tr: cs(chip, 'transform'),
            shadow: cs(chip, 'box-shadow'), hit: sig(document.elementFromPoint(r2.left + r2.width / 2, r2.top + r2.height / 2)) };
          beat3.token = !!localStorage.getItem('__tmp__test_gh_pat');
          beat3.toast = window.__toasts.slice(-1)[0] || '';
          return { beat1, beat2, beat3 };
        `);
        check("E9. 第一拍：按鈕變「✓ 解開了」＋kr-okpop、不變暗（opacity 1）、頭像跑 kr-ring；金鑰**當下就寫進去**（§4-8）",
          !!s.beat1 && /解開了/.test(s.beat1.go) && s.beat1.goOpacity === "1" && s.beat1.goAnim === "kr-okpop"
          && s.beat1.ring === "kr-ring" && s.beat1.unlockedNow,
          JSON.stringify(s.beat1));
        /* 斷言「有沒有走那一拍」，不是「第 N 毫秒長怎樣」—— kr-leave kr-up 只活 230ms */
        check("E10. 第二拍：層曾經進入 kr-leave kr-up（往前退開）",
          s.beat2.started && s.beat2.sawLeaveUp, "class 變動軌跡=" + JSON.stringify(s.beat2.clsTrail));
        const lying = s.beat2.scan.filter(x => x.txt && !/可以編輯/.test(x.txt));
        /* 嚴格母體只取 dt<=200：那是「層一定還在、藥丸一定還在 delay 裡」的區間。
         * dt=235 落在設計邊界上（收尾計時器 230ms vs 藥丸 delay 240ms，只差 10ms），
         * 主執行緒抖一下就會互換順序 —— 那個交界不該拿來當紅線（會變成擲骰子）。
         * 交界之後改用另一條斷言：藥丸**必須**已經開始彈出（證明第三拍真的接上了）。 */
        const inLeave = s.beat2.scan.filter(x => x.at <= 200);
        const clickable = inLeave.filter(x => !x.layerHidden && (x.o !== "0" || x.pe !== "none" || /kr-chip/.test(x.hit)));
        const last = s.beat2.scan[s.beat2.scan.length - 1];
        check("E11. 退場全程掃描：藥丸標籤已經誠實、而且看不見也點不到（§4-8 的說謊窗＝0）",
          lying.length === 0 && clickable.length === 0 && Number(last.o) > 0 && /kr-chip/.test(last.hit),
          s.beat2.scan.map(x => "dt" + x.dt + "(實測" + x.at + ") " + (x.txt || "-") + " o=" + x.o + " pe=" + x.pe + " hit=" + x.hit + (x.layerHidden ? " [層已消失]" : "")).join("\n      "));
        check("E12. 第三拍：整條路徑藥丸只建立 1 次、時序是 CSS 的 delay(240ms)+fill:both（零 JS 計時器）",
          s.beat3.chipNodes === 1 && s.beat3.hasNew && /kr-chipin/.test(s.beat3.anim) && /kr-chipglow/.test(s.beat3.anim)
          && /0\.24s/.test(s.beat3.delay) && /both/.test(s.beat3.fill),
          "建立 " + s.beat3.chipNodes + " 次 / animation=" + s.beat3.anim + " / delay=" + s.beat3.delay + " / fill=" + s.beat3.fill);
        check("E13. 動畫播完藥丸自己回到可見可點（全靠 CSS，沒有 JS 收尾）",
          s.beat3.after.o === "1" && s.beat3.after.pe === "auto" && /kr-chip/.test(s.beat3.after.hit) && s.beat3.after.shadow === "none",
          JSON.stringify(s.beat3.after));
        check("E14. 金鑰真的解出來、寫進宿主的 localStorage（假 token round-trip）", s.beat3.token,
          "toast: " + s.beat3.toast);

        const r3 = await page.eval(PRE + `
          Keyring.openIdentity(); await wait(150);
          document.getAnimations().forEach(a => a.finish());
          Keyring.close();                                   /* 開始退場 */
          await wait(110);
          const chip = $('.kr-chip'); chip.getAnimations().forEach(a => a.finish());
          chip.click();                                      /* 退場途中點它 */
          const out = [];
          for (const dt of [300, 500, 900]) { await wait(200);
            out.push({ dt, hidden: $('#kr-full').hidden, open: Keyring.current().open,
              name: ($('#kr-full .kr-id b') || {}).textContent || null }); }
          return out;
        `);
        check("E15. 退場途中點藥丸開身分頁，不會被舊計時器關掉（守衛在 paint()，R-3 的原形）",
          r3.every(x => x.hidden === false && x.name), JSON.stringify(r3));
      }
    }

    /* ---------- G：底部露白 ---------- */
    if (wants("G")) {
      head("G  底部露白（--kr-vh 407 ＋ iOS 位移 46）＋ 反向對照");
      await gotoHost(page, base, "travel", 3);
      const geo = await page.eval(PRE + `
        document.documentElement.style.background = '#ff00ff';
        document.body.style.background = '#ff00ff';         /* 宿主底色故意用洋紅：漏一格都看得見 */
        Keyring.open(''); await wait(80);
        document.getAnimations().forEach(a => a.finish());
        const r = document.documentElement.style;
        r.setProperty('--kr-vh', '407px'); r.setProperty('--kr-top', '46px');
        await wait(120);
        const L = $('#kr-full').getBoundingClientRect();
        return { top: Math.round(L.top), bottom: Math.round(L.bottom), vh: innerHeight };
      `);
      const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const img = png.decode(shot.data);
      const pts = [[187, 10], [5, 5], [187, geo.bottom + 20], [370, 715], [187, 715]];
      const cols = pts.map(([x, y]) => img.px(x, y));
      const isBleed = (c) => Math.abs(c[0] - 25) < 8 && Math.abs(c[1] - 21) < 8 && Math.abs(c[2] - 16) < 8;
      const leaks = cols.filter(c => !isBleed(c));
      check("G1. 層以外（上 " + geo.top + "px、下 " + (geo.vh - geo.bottom) + "px）畫的是 --krs-bleed #191510，沒有宿主底色",
        leaks.length === 0,
        pts.map((p, i) => "(" + p.join(",") + ")=rgb(" + cols[i].join(",") + ")").join("  "));
      await page.eval(PRE + `
        const st = document.createElement('style'); st.id = '__tmp__nofix';
        st.textContent = '#kr-full{top:0 !important;} #kr-full::before{box-shadow:none !important;}';
        document.head.appendChild(st); await wait(120); return true;
      `);
      const shot2 = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const below = png.decode(shot2.data).px(187, 700);
      /* 宿主可能自己有一層底（travel 的 #app 是 --bg #f7f4ee），所以判準是
       * 「這一格不再是 --krs-bleed，而且是亮的」＝ 露出了宿主，不必指定某個顏色。 */
      check("G2. 反向對照：關掉修法後同一區露出宿主底色 ⇒ 這支探針不是恆綠",
        !isBleed(below) && (below[0] + below[1] + below[2]) / 3 > 120,
        "(187,700)=rgb(" + below.join(",") + ")（修好時同一區是 rgb(25,21,16)）");
      await page.eval("document.getElementById('__tmp__nofix').remove(); return true;");
    }

    /* ---------- H：prefers-reduced-motion ---------- */
    if (wants("H")) {
      head("H  prefers-reduced-motion：真的不播，藥丸仍可見可點");
      await page.send("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await gotoHost(page, base, "blank", 3);
      const h = await page.eval(PRE + `
        const out = {};
        out.rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
        Keyring.open(''); await wait(60);
        const L = $('#kr-full');
        out.openCls = [...L.classList].filter(c => /kr-a-/.test(c)).join(',');
        out.layerAnim = cs(L, 'animation-name');
        document.querySelectorAll('.kr-tile')[1].click(); await wait(60);
        out.stepCls = [...L.classList].filter(c => /kr-a-/.test(c)).join(',');
        out.avInline = ($('.kr-id .kr-av').getAttribute('style') || '').indexOf('transform') >= 0;
        /* 讀取轉圈是狀態指示，必須留著 */
        const sp = document.createElement('span'); sp.className = 'kr-spin';
        $('.kr-field').appendChild(sp); out.spin = cs(sp, 'animation-name'); sp.remove();
        /* ⚠️ 減少動態下第二拍的等待是 0ms ⇒ 「✓ 解開了」那一版 DOM 一瞬間就被關掉了，
         * 用輪詢一定抓不到。改用 MutationObserver 記錄它有沒有真的被畫出來過。 */
        const seen = [];
        const mo = new MutationObserver(() => { const g = $('#kr-full .kr-go'); if (g) seen.push(g.textContent.trim()); });
        mo.observe(L, { childList: true, subtree: true });
        $('#kr-pw').value = 'pw-1';
        $('#kr-full form').requestSubmit();
        const t0 = performance.now();
        while (!(Keyring.isUnlocked() && L.hidden) && performance.now() - t0 < 15000) await wait(16);
        await wait(120);
        mo.disconnect();
        out.doneRendered = seen.some(t => /解開了/.test(t));
        out.seen = seen;
        out.layerHidden = L.hidden; out.leaveCls = L.className;
        const chip = $('.kr-chip');
        out.chipNew = chip.classList.contains('kr-new');
        const r = chip.getBoundingClientRect();
        out.chip = { o: cs(chip, 'opacity'), pe: cs(chip, 'pointer-events'), anim: cs(chip, 'animation-name'),
          hit: sig(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
        /* 突變式檢查：硬把 kr-new 掛上去，那條 !important 必須把 fill 一起關掉 */
        chip.classList.add('kr-new'); await wait(60);
        const r2 = chip.getBoundingClientRect();
        out.forced = { anim: cs(chip, 'animation-name'), o: cs(chip, 'opacity'), pe: cs(chip, 'pointer-events'),
          hit: sig(document.elementFromPoint(r2.left + r2.width / 2, r2.top + r2.height / 2)) };
        return out;
      `);
      check("H1. 減少動態下不掛任何進場 class、層自己也不播 kr-in、沒有頭像形變",
        h.rm && h.openCls === "" && h.stepCls === "" && h.layerAnim === "none" && h.avInline === false,
        JSON.stringify({ openCls: h.openCls, stepCls: h.stepCls, layerAnim: h.layerAnim, morph: h.avInline }));
      check("H2. 讀取轉圈（.kr-spin）保留", h.spin === "kr-sp", "animation=" + h.spin);
      check("H3. 「✓ 解開了」仍會 render 一幀（那是狀態不是動作），退場直接 hidden、不留 kr-leave",
        h.doneRendered && h.layerHidden && !/kr-leave/.test(h.leaveCls),
        "hidden=" + h.layerHidden + " class=[" + h.leaveCls + "] 畫過的按鈕文字=" + JSON.stringify(h.seen));
      check("H4. 藥丸不掛 kr-new，最終可見可點", h.chipNew === false && h.chip.o === "1" && h.chip.pe === "auto" && /kr-chip/.test(h.chip.hit),
        JSON.stringify(h.chip));
      check("H5. 突變檢查：硬掛 kr-new 也不會卡成隱形（.kr-chip.kr-chip{animation:none!important} 是承重的）",
        h.forced.anim === "none" && h.forced.o === "1" && h.forced.pe === "auto" && /kr-chip/.test(h.forced.hit),
        JSON.stringify(h.forced));
      await page.send("Emulation.setEmulatedMedia", { media: "", features: [] });
    }
  } finally {
    await b.close();
    srv.close();
  }

  const bad = results.filter(r => !r.ok);
  console.log("\n" + "=".repeat(64));
  console.log(bad.length ? "❌ " + bad.length + " / " + results.length + " 條沒過：\n   - " + bad.map(r => r.name).join("\n   - ")
    : "✅ 全部 " + results.length + " 條通過");
  process.exit(bad.length ? 1 : 0);
}

run().catch((e) => { console.error("\n跑不完：", e); process.exit(2); });
