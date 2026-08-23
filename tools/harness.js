"use strict";
/*
 * harness.js — 給檢查腳本用的本機測試宿主（零依賴）。
 *
 * 為什麼要起一個真的 http server 而不是 file://：WebCrypto 只在安全來源可用，
 * 而解鎖流程的重點就是「解得開／解不開」，一定要跑真的 PBKDF2＋AES-GCM。
 *
 * 三個宿主：
 *   travel ＝ 旅途手帳的真 styles.css（含 .home-foot button 這條歷史上壓過藥丸的規則）
 *   recipe ＝ 食譜本的真 styles.css
 *   blank  ＝ 完全沒有任何 CSS／變數的空白頁（新 App 零設定的情境）
 * 「公版」的機器定義＝這三個宿主量到的 computed style 逐項相同。
 *
 * ⚠️ 全程用**假 token**（ghp_FAKE_…）：要驗的是 round-trip 解得開，真金鑰不進測試。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WORK = path.resolve(ROOT, "..");
const FILES = {
  "/keyring-unlock.js": [path.join(ROOT, "client/keyring-unlock.js"), "text/javascript; charset=utf-8"],
  "/host/travel.css": [path.join(WORK, "travel-planner/public/styles.css"), "text/css; charset=utf-8"],
  "/host/recipe.css": [path.join(WORK, "recipe-book/public/styles.css"), "text/css; charset=utf-8"]
};

const HOST_BODY = {
  travel: '<div id="app"><div class="home-head"><h1>旅途手帳</h1></div>'
    + '<footer class="home-foot" id="chipHost"></footer></div>',
  recipe: '<div class="wrap"><div class="card"><div id="chipHost" class="kr-slot"></div>'
    + '<p class="readonly-note">📖 唯讀瀏覽模式</p></div></div>',
  blank: '<div id="chipHost"></div>'
};
const HOST_CSS = { travel: "/host/travel.css", recipe: "/host/recipe.css", blank: null };

function page(host, users) {
  const css = HOST_CSS[host] ? '<link rel="stylesheet" href="' + HOST_CSS[host] + '">' : "";
  return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>🧪 ' + host + '</title>' + css
    + '</head><body>' + (HOST_BODY[host] || HOST_BODY.blank)
    + '<script src="/keyring-unlock.js"></script>'
    + '<script>' + boot(users) + '<\/script></body></html>';
}

/* 頁面內的啟動腳本：造一份假鑰匙圈（真加密、假 token）、把 fetch 擋下來、init 模組。 */
function boot(users) {
  return `
var APP_ID="test-app", PW="pw-0";
var NAMES=["Benson","女友","小明","阿德","Kiki","Ryan","小美","Tom"];
var EMO=["🧔","👩","🧑","🧓","👧","👦","👩‍🦰","🧑‍🦱"];
var THEMES=["sunset","ocean","night","forest","sand"];
function b64(u8){var s="";for(var i=0;i<u8.length;i++)s+=String.fromCharCode(u8[i]);return btoa(s);}
async function buildRing(n){
  var enc=new TextEncoder(), out=[];
  for(var i=0;i<n;i++){
    var salt=crypto.getRandomValues(new Uint8Array(16)), iter=60000;   /* 只為了跑得快，路徑與正式完全相同 */
    var base=await crypto.subtle.importKey("raw",enc.encode("pw-"+i),"PBKDF2",false,["deriveKey"]);
    var key=await crypto.subtle.deriveKey({name:"PBKDF2",salt:salt,iterations:iter,hash:"SHA-256"},
      base,{name:"AES-GCM",length:256},true,["encrypt","decrypt"]);
    var iv=crypto.getRandomValues(new Uint8Array(12));
    var cipher=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:iv},key,
      enc.encode("ghp_FAKE_TOKEN_ONLY_FOR_TEST_"+i)));
    var apps={}; apps[APP_ID]={iv:b64(iv),cipher:b64(cipher)};
    out.push({id:"u-"+i,name:NAMES[i%8],emoji:EMO[i%8],theme:THEMES[i%5],
      kdf:{algo:"PBKDF2-SHA256",iter:iter,salt:b64(salt)},apps:apps});
  }
  return {version:1,updatedAt:new Date().toISOString(),apps:[{id:APP_ID,name:"測試",emoji:"🧪"}],users:out};
}
window.__toasts=[]; window.__chipRenders=0;
function renderChip(){ var h=document.getElementById("chipHost");
  h.innerHTML=Keyring.chipHtml(); window.__chipRenders++; }
window.__ready=(async function(){
  var ring=await buildRing(${users});
  var realFetch=window.fetch;
  window.fetch=function(u){ if(String(u).indexOf("keyring.json")>=0)
      return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(JSON.parse(JSON.stringify(ring)));}});
    return realFetch.apply(this,arguments); };
  Keyring.init({appId:APP_ID, tokenKey:"__tmp__test_gh_pat", appName:"🧪 測試 App",
    toast:function(m){window.__toasts.push(m);}, onChange:renderChip});
  renderChip();
  await Keyring.reload();
  return true;
})();
`;
}

function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (FILES[u.pathname]) {
      const [f, type] = FILES[u.pathname];
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(fs.readFileSync(f));
      return;
    }
    if (u.pathname.startsWith("/h/")) {
      const host = u.pathname.slice(3) || "blank";
      const users = Number(u.searchParams.get("users") || 3);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page(host, users));
      return;
    }
    res.writeHead(404); res.end("nope");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}
module.exports = { serve };
