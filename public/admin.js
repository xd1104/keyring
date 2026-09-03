"use strict";
/*
 * 鑰匙圈後台 — 前端（視覺與文案照 DESIGN.md B 段與 demo/index.html）
 * 明文金鑰只往這台電腦的 server 送一次，之後畫面上只看得到遮罩。
 * 存檔即自動發布（Benson 拍板）：沒有「未發布變更」的草稿狀態，也沒有發布按鈕，
 * 只有「上一次發布結果」的狀態列；失敗才給「再試一次」。
 */

var THEMES = {
  sunset:"linear-gradient(135deg,#ff8a80,#ff5f7e 55%,#c94b9d)",
  ocean: "linear-gradient(135deg,#38c3a7,#2f8fd6)",
  night: "linear-gradient(135deg,#6a7bf0,#8e54c9)",
  forest:"linear-gradient(135deg,#7ec96f,#3f9d8a)",
  sand:  "linear-gradient(135deg,#f5c65d,#f0855c)"
};
var THEME_KEYS = Object.keys(THEMES);
var EMOJIS = ["🧔","👩","🧑","👧","👦","🐱","🐶","🦊","🐻","🌻","⭐","🍀"];
var APP_EMOJIS = ["📦","🧳","🍳","🏋️","📓","🎮"];

var S = { apps:[], users:[], publish:{ok:true, message:"", at:null},
          sync:{ok:true, message:"", adopted:false}, vault:{enabled:false},
          appsFile:{ok:true, message:""} };
/* 管理主控台（2026-08-28）：進來先看到 App —— 他最常做的事是看 App 的狀態 */
var adTab = "apps";
var formState = {};
/* 近況（變更紀錄）與各 App 的更新時間。都是「有沒有資料」與「畫不畫面」解耦：
 * 拿不到就顯示「—」，不擋畫面、不跳錯誤。 */
var LOG = { rows:null, busy:false, err:"", limit:30 };
var PUSHED = { map:{}, at:0, tried:false };
var OPENLOG = {};      /* 哪幾張卡片被展開了 */
var APPLOG = {};       /* appId -> 最近 3 筆 commit */

/* 🧰 工具分頁（2026-09-01 從 tool-manager 搬進來，那支之後退役）。
 * 只有電腦端有——啟動頁與手機後台都沒有這台電腦的 server，本機程式永遠開不起來。
 * 刻意不做 3 秒輪詢（tool-manager 是那樣做的）：這個後台的 render() 是整片
 * innerHTML 重建，每 3 秒重建一次會把滑鼠底下的按鈕抽掉（travel-book／trade-log
 * 都踩過）。改成：進分頁載一次、按鈕手動重新整理、按了啟動／停止之後追幾次。 */
var TOOLS = { list:null, file:{ok:true,message:""}, err:"", at:0, busy:{}, loading:false,
              chase:0, timer:null, openLog:{}, logs:{} };

/* ---------- 小工具 ---------- */
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function grad(t){ return THEMES[t]||THEMES.sunset; }
function userById(id){ for(var i=0;i<S.users.length;i++) if(S.users[i].id===id) return S.users[i]; return null; }
function appById(id){ for(var i=0;i<S.apps.length;i++) if(S.apps[i].id===id) return S.apps[i]; return null; }
var toastTimer=null;
function toast(msg, kind){
  var el=$("toast"); el.textContent=msg; el.className=kind||"";
  clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){ el.className=(kind||"")+" hidden"; }, 2800);
}
function fmtTime(iso){
  if(!iso) return "";
  var d=new Date(iso);
  if(isNaN(d.getTime())) return "";
  return (d.getMonth()+1)+"/"+d.getDate()+" "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
}

/* ---------- 跟本機 server 說話 ---------- */
function api(path, method, body){
  return fetch("api"+path, {
    method: method||"GET",
    headers: body ? {"Content-Type":"application/json"} : undefined,
    body: body ? JSON.stringify(body) : undefined
  }).then(function(r){
    return r.json().catch(function(){ return {ok:false, message:"後台回了看不懂的東西，重新整理看看"}; })
      .then(function(d){
        /* 錯誤訊息一律優先用 server 給的人話，別把 HTTP 狀態碼丟到使用者臉上 */
        if(!r.ok || !d.ok) throw new Error(d.message || "這一步沒成功，再試一次看看");
        return d;
      });
  }, function(){ throw new Error("連不到鑰匙圈後台（server.js 沒開？）"); });
}
function applyState(d){ if(d && d.state){ S=d.state; render(); } }

/* ---------- 版面 ---------- */
function render(){
  $("admin").innerHTML = ''
    + '<div class="ad-head"><h1>🔑 鑰匙圈</h1>'
    +   '<p>管理誰可以編輯哪個 App。存檔就自動發布出去，不用另外按什麼。</p></div>'
    + pubBar()
    + syncBar()
    + appsFileBar()
    + '<div class="ad-tabs">'
    +   '<button class="'+(adTab==="apps"?"on":"")+'" onclick="setTab(\'apps\')">📦 App</button>'
    +   '<button class="'+(adTab==="users"?"on":"")+'" onclick="setTab(\'users\')">👥 使用者</button>'
    +   '<button class="'+(adTab==="tools"?"on":"")+'" onclick="setTab(\'tools\')">🧰 工具</button>'
    +   '<button class="'+(adTab==="log"?"on":"")+'" onclick="setTab(\'log\')">🕘 近況</button>'
    +   '<button class="'+(adTab==="vault"?"on":"")+'" onclick="setTab(\'vault\')">📱 手機後台</button>'
    + '</div>'
    + (adTab==="users" ? adUsers() : adTab==="apps" ? adApps()
       : adTab==="tools" ? adTools() : adTab==="log" ? adLog() : adVault())
    /* 手機後台與工具那兩頁有自己的說明，不要再疊一段講使用者密碼的 */
    + (adTab==="vault" || adTab==="tools" ? '' :
        '<div class="ad-foot">密碼是各自加密的，這裡看不到、也救不回來。<br>'
      + '有人忘記密碼，就在這裡幫他換一組新的。金鑰的明文只留在這台電腦。<br>'
      /* 啟動頁是免密碼的那一頁（加到手機主畫面用），本機預覽在 /launch/ */
      + '啟動頁：<a href="'+esc(S.launchUrl||"https://xd1104.github.io/keyring/")+'" target="_blank" rel="noopener">'
      + esc((S.launchUrl||"https://xd1104.github.io/keyring/").replace(/^https:\/\//,""))+'</a>'
      + '　（在這台電腦先看：<a href="/launch/" target="_blank" rel="noopener">/launch/</a>）</div>');
}
function setTab(t){
  adTab=t;
  if(t!=="tools") stopToolChase();      /* 離開分頁就別再背景重建畫面 */
  render();
  if(t==="log" && !LOG.rows && !LOG.busy) loadLog(LOG.limit);
  if(t==="apps" && !PUSHED.tried) loadPushed(false);
  if(t==="tools" && !TOOLS.loading) loadTools();
}

/* 啟動頁的公開清單產不出來時要講原因（例如名字裡被貼了金鑰）。
 * ⚠️ 不靜靜跳過：跳過的話啟動頁會停在舊清單，而他以為存好了。 */
function appsFileBar(){
  var a=S.appsFile||{};
  if(a.ok!==false) return "";
  return '<div class="pub-bar bad"><div class="pub-txt"><b>啟動頁的清單這次沒有更新</b>'
    + '<span>'+esc(a.message||"")+'</span></div></div>';
}

function pubBar(){
  var p=S.publish||{};
  if(p.ok){
    return '<div class="pub-bar"><div class="pub-txt"><b>✓ 存檔就自動發布了</b>'
      + '<span>'+(p.at ? "最後一次 "+esc(fmtTime(p.at))+"　各裝置打開就是最新的" : "還沒有東西要發布")+'</span></div></div>';
  }
  /* 失敗時：講人話 ＋ 明確告訴他下一步 ＋ 一定要說「東西已經存好了，不會不見」 */
  var steps = (p.how&&p.how.length)
    ? '<ul class="pub-list">'+p.how.map(function(h,i){ return '<li>'+(i+1)+'. '+esc(h)+'</li>'; }).join("")+'</ul>'
    : '';
  return '<div class="pub-bar bad"><div class="pub-txt"><b>存好了，但還沒送到 GitHub</b>'
    + '<span>'+esc(p.message||"")+'</span></div>'
    + '<div class="pub-acts">'
    +   (p.canSetup ? '<button class="pub-btn" onclick="doSetup(this)">🔗 幫我接起來</button>' : '')
    +   '<button class="pub-btn '+(p.canSetup?"sub":"")+'" onclick="retryPublish(this)">再試一次</button>'
    + '</div>'
    + steps + '</div>';
}
function afterPublish(d){
  applyState(d);
  if(S.publish && S.publish.ok) toast("發布好了，各裝置下次打開就會拿到新的鑰匙圈","ok");
  else toast(S.publish ? S.publish.message : "還是沒送出去", "err");
}
function retryPublish(btn){
  btn.disabled=true; btn.textContent="發布中…";
  api("/publish","POST").then(afterPublish).catch(function(e){
    api("/state").then(applyState).catch(function(){});
    toast(e.message, "err");
  });
}
function doSetup(btn){
  btn.disabled=true; btn.textContent="接線中…";
  api("/setup","POST").then(function(d){
    applyState(d);
    if(S.publish && S.publish.ok) toast("接好了，也送出去了 🎉","ok");
    else toast(S.publish ? S.publish.message : "接線沒成功", "err");
  }).catch(function(e){
    api("/state").then(applyState).catch(function(){});
    toast(e.message, "err");
  });
}

/* 兩邊都能改，所以「跟 GitHub 對時」失敗要講出來：
 * 對不到時這台電腦有可能拿著舊的真本在改，那件事必須讓他知道。 */
function syncBar(){
  var s=S.sync||{};
  if(!S.vault || !S.vault.enabled || s.ok!==false) return "";
  return '<div class="pub-bar bad"><div class="pub-txt"><b>沒跟手機那邊對到時間</b>'
    + '<span>'+esc(s.message||"")+'　現在改東西有可能蓋掉手機上剛改的。</span></div>'
    + '<div class="pub-acts"><button class="pub-btn" onclick="doSync(this)">再對一次</button></div></div>';
}
function doSync(btn){
  busy(btn, "對時中…");
  api("/sync","POST").then(function(d){
    applyState(d);
    toast(S.sync && S.sync.ok ? "對好了" : (S.sync.message||"還是對不到"), S.sync && S.sync.ok ? "ok" : "err");
  }).catch(function(e){ toast(e.message,"err"); render(); });
}

/* ---------- 手機後台 ---------- */
/* 手機那邊沒有伺服器可以問，所以真本要加密成 vault.json 放上公開 repo：
 * 解它需要「管理密碼 ＋ 裝置配對碼」，配對碼只住在裝置裡、不進任何公開檔案。 */
function adVault(){
  var v=S.vault||{};
  if(!v.enabled){
    return '<div class="empty"><div class="big">📱</div>'
      + '<p>還沒開手機後台。<br>開了之後，你在任何一支手機上開一個網頁就能加人、換密碼、貼新金鑰，<br>'
      +   '不用回到這台電腦。</p></div>'
      + '<div class="warnbox" style="margin-bottom:14px">開了之後，這份鑰匙圈的<b>全部內容</b>（明文 PAT 與每個人的派生金鑰）'
      +   '會加密成公開的 vault.json 送上 GitHub。解得開它需要兩樣東西：你等一下設的<b>管理密碼</b>，'
      +   '加上這台電腦產生的<b>裝置配對碼</b>（只會出現在這裡跟你貼過的裝置上）。</div>'
      + '<button class="addcard" onclick="openVaultForm(true)">＋ 開啟手機後台</button>';
  }
  var link = v.webUrl + "#pair=" + v.pairing;
  return '<div class="sec-title">手機上打開這個網址</div>'
    + '<div class="rowcard"><div class="rc-bd"><b>網址</b>'
    +   '<div class="keyline">'+esc(v.webUrl)+'</div></div>'
    +   '<div class="rc-acts"><button onclick="copyText('+JSON.stringify(v.webUrl).replace(/"/g,"&quot;")+', this)">複製</button></div></div>'
    + '<div class="rowcard"><div class="rc-bd"><b>裝置配對碼</b>'
    +   '<div class="keyline" style="font-size:16px; letter-spacing:1px">'+esc(v.pairing)+'</div>'
    +   '<div class="chips"><span class="chip none">手機第一次要貼一次，之後只要輸密碼</span></div></div>'
    +   '<div class="rc-acts"><button onclick="copyText('+JSON.stringify(link).replace(/"/g,"&quot;")+', this)">複製連結</button></div></div>'
    + '<div class="sec-title">手機那邊寫回 GitHub 用的金鑰</div>'
    + '<div class="rowcard"><div class="rc-bd"><b>'+(v.hasGh?"已經設好了":"還沒設 —— 手機現在只能看，存不回去")+'</b>'
    +   '<div class="keyline">'+esc(v.ghMasked||"（還沒有）")+'</div>'
    +   '<div class="chips"><span class="chip none">fine-grained PAT · 只給這個 keyring repo 的 Contents: Read and write</span></div></div>'
    +   '<div class="rc-acts"><button onclick="openVaultGh()">'+(v.hasGh?"換一把":"貼一把")+'</button></div></div>'
    + '<div class="sec-title">其他</div>'
    + '<div class="rowcard"><div class="rc-bd"><b>換管理密碼／換配對碼</b>'
    +   '<div class="chips"><span class="chip none">換了之後，每一支手機都要重新配對一次</span></div></div>'
    +   '<div class="rc-acts"><button onclick="openVaultForm(false)">換</button>'
    +   '<button class="danger" onclick="askDisableVault()">關掉手機後台</button></div></div>'
    + '<div class="ad-foot">解 vault.json 的金鑰存在這台電腦的 vault.key（跟 secrets.json 一樣永不上傳）。<br>'
    +   '手機改完之後，這台電腦下次動手之前會自動把它接手過來。</div>';
}

function copyText(text, btn){
  var done=function(ok){
    if(btn){ btn.textContent = ok?"複製好了":"複製不了"; setTimeout(function(){ render(); }, 1200); }
    if(!ok) toast("複製不了，直接選起來複製", "err");
  };
  if(navigator.clipboard) navigator.clipboard.writeText(text).then(function(){done(true);}, function(){done(false);});
  else done(false);
}

function openVaultForm(isNew){
  openDialog('<div class="sheet-head"><h3>'+(isNew?"開啟手機後台":"換管理密碼")+'</h3>'
    +   '<button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="hint" style="margin-top:0">這一組密碼加上配對碼，才解得開 vault.json。'
    +   '它跟使用者的密碼是兩回事 —— 它等於所有 App 的金鑰，設長一點。</div>'
    + '<label class="field"><span class="fl">管理密碼</span>'
    +   '<input id="vf-pw" type="password" placeholder="至少 8 個字" autocomplete="new-password" '
    +   'autocapitalize="off" spellcheck="false"></label>'
    + (isNew ? '' :
        '<label class="field" style="display:flex; align-items:center; gap:10px">'
        + '<input id="vf-newpair" type="checkbox" style="width:20px; height:20px; margin:0">'
        + '<span class="fl" style="margin:0">順便換一組新的配對碼</span></label>'
        + '<div class="hint">勾了的話，每一支已經配對過的手機都要重新貼一次。</div>')
    + '<div class="warnbox">換完之後 vault.json 會用新金鑰重寫一次。已經配對的手機不用重貼配對碼（除非你勾了上面那個），但要改用新密碼。</div>'
    + '<button class="btn-primary" onclick="saveVault(this)">'+(isNew?"開啟":"換成這組")+'</button>', "vf-pw");
}
function saveVault(btn){
  var pw=($("vf-pw").value||"");
  if(pw.length<8){ toast("管理密碼至少 8 個字", "err"); return; }
  var newPair = $("vf-newpair") ? $("vf-newpair").checked : false;
  busy(btn, "產生金鑰中…");
  api("/vault","POST",{password:pw, newPairing:newPair})
    .then(function(d){ applyState(d); closeSheet(); adTab="vault"; render();
      toast("開好了，手機那邊照畫面上的網址跟配對碼進去","ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="開啟"; } });
}
function openVaultGh(){
  openDialog('<div class="sheet-head"><h3>手機寫回 GitHub 的金鑰</h3>'
    +   '<button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="hint" style="margin-top:0">手機那邊沒有 git，是直接呼叫 GitHub API 寫回這個 keyring repo。'
    +   '用 fine-grained PAT，Repository access 只勾 keyring，權限只給 Contents: Read and write。</div>'
    + '<label class="field"><span class="fl">金鑰</span>'
    +   '<input id="vg-key" type="password" placeholder="github_pat_…" autocomplete="off" spellcheck="false"></label>'
    + '<div class="warnbox">它只會加密進 vault.json，不會出現在 keyring.json，也不會進任何明文檔案。'
    +   '這把跟各 App 那些「只授權自己那一個 repo」的金鑰是分開的兩件事。</div>'
    + '<button class="btn-primary" onclick="saveVaultGh(this)">存起來</button>', "vg-key");
}
function saveVaultGh(btn){
  var k=($("vg-key").value||"").trim();
  if(!k){ toast("先貼上金鑰", "err"); return; }
  busy(btn, "存檔中…");
  api("/vault/github","POST",{token:k})
    .then(function(d){ applyState(d); closeSheet(); toast("存好了，手機那邊現在可以存回來了","ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="存起來"; } });
}
function askDisableVault(){
  openDialog('<div class="sheet-head"><h3>關掉手機後台？</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="warnbox">vault.json 會從 repo 上刪掉，手機那邊就進不去了。'
    + '這台電腦的 secrets.json 一點都不會動，本機後台照常用。</div>'
    + '<button class="btn-danger" onclick="doDisableVault(this)" style="margin-bottom:10px">關掉</button>'
    + '<button class="btn-ghost" onclick="closeSheet()">算了</button>');
}
function doDisableVault(btn){
  busy(btn, "關閉中…");
  api("/vault","DELETE")
    .then(function(d){ applyState(d); closeSheet(); toast("關掉了"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="關掉"; } });
}

function adUsers(){
  if(!S.users.length){
    return '<div class="empty"><div class="big">🧑‍🤝‍🧑</div><p>還沒有任何人。<br>先新增一個人，再給他一組密碼。</p></div>'
      + '<button class="addcard" onclick="openUserForm(null)">＋ 新增使用者</button>';
  }
  var rows = S.users.map(function(u){
    var chips = u.apps.length
      ? u.apps.map(function(a){ var ap=appById(a); return ap ? '<span class="chip">'+ap.emoji+' '+esc(ap.name)+'</span>' : ""; }).join("")
      : '<span class="chip none">還沒給任何 App</span>';
    return '<div class="rowcard">'
      + '<div class="rc-face" style="background:'+grad(u.theme)+'">'+u.emoji+'</div>'
      + '<div class="rc-bd"><b>'+esc(u.name)+'</b><div class="chips">'+chips+'</div></div>'
      + '<div class="rc-acts">'
      +   '<button onclick="openUserForm(\''+u.id+'\')">編輯</button>'
      +   '<button onclick="openPwForm(\''+u.id+'\')">換密碼</button>'
      +   '<button class="danger" onclick="askDeleteUser(\''+u.id+'\')">刪除</button>'
      + '</div></div>';
  }).join("");
  return '<div class="sec-title">使用者（'+S.users.length+'）</div>'+rows
    + '<button class="addcard" onclick="openUserForm(null)">＋ 新增使用者</button>';
}

/* 到期 chip：狀態的算法在 KF（啟動頁、兩個後台同一份），這裡只負責畫 */
function keyChipHtml(a){
  if(!a.keyed) return '<span class="chip none">只有連結</span>';
  var st=a.key||{state:"unknown"};
  var cls = st.state==="expired" ? "bad" : (st.state==="soon" ? "warn" : (st.state==="unknown" ? "none" : "ok"));
  return '<span class="chip '+cls+'">'+esc(KF.keyLabel(st))+'</span>';
}
function agoOf(iso){
  var t=Date.parse(iso||"");
  if(isNaN(t)) return "—";
  var d=Date.now()-t, H=3600e3, D=86400e3;
  if(d<90e3) return "剛剛";
  if(d<H) return Math.max(1,Math.round(d/60e3))+" 分鐘前";
  if(d<22*H) return Math.round(d/H)+" 小時前";
  if(d<44*H) return "昨天";
  if(d<8*D) return Math.round(d/D)+" 天前";
  var x=new Date(t); return (x.getMonth()+1)+"/"+x.getDate();
}
function adApps(){
  if(!S.apps.length){
    return '<div class="empty"><div class="big">📦</div><p>還沒登記任何 App。<br>登記之後，鑰匙才有東西可以配。</p></div>'
      + '<button class="addcard" onclick="openAppForm()">＋ 登記新的 App</button>';
  }
  var rows = S.apps.map(function(a){
    var who = S.users.filter(function(u){ return u.apps.indexOf(a.id)>=0; });
    var chips = who.length
      ? who.map(function(u){ return '<span class="chip">'+u.emoji+' '+esc(u.name)+'</span>'; }).join("")
      : '<span class="chip none">還沒有人可以用</span>';
    var repo = a.repo || a.repoGuess || "";
    var open = !!OPENLOG[a.id];
    var logRows = APPLOG[a.id];
    return '<div class="rowcard stack"><div class="rc-top">'
      + '<div class="rc-face" style="background:'+grad("sand")+'">'+a.emoji+'</div>'
      + '<div class="rc-bd"><b>'+esc(a.name)+'</b>'
      +   (a.url ? '<span class="rc-url">'+esc(a.url.replace(/^https?:\/\//,""))+'</span>'
                 : '<span class="rc-url miss">⚠ 還沒填網址，啟動頁點不開</span>')
      +   '<div class="chips">'+keyChipHtml(a)
      +     '<span class="chip">'+(repo ? "更新於 "+esc(agoOf(PUSHED.map[repo])) : "沒有 repo")+'</span>'
      +     (a.public ? '<span class="chip warn">公開模式</span>' : '')
      +     chips
      +   '</div>'
      +   (a.public ? '<div class="keyline" style="color:#8a5b12">🌐 公開：這個 App 的金鑰是<b>明文</b>放在公開 repo，任何人都看得到</div>' : '')
      +   (a.publicBlocked ? '<div class="keyline" style="color:#d64545">⛔ 勾了公開但被擋下來了（值看起來是 GitHub token），目前仍然是加密的</div>' : '')
      +   '<div class="keyline">'+esc(a.masked||"（還沒有金鑰）")+'</div>'
      +   (a.splash ? '<div class="keyline">🎬 開場外觀：'+esc(splashSummary(a.splash))+'</div>' : '')
      +   ((a.fields||[]).length && a.fieldsOk===false
            ? '<div class="keyline" style="color:#8a5b12">⚠ 這個 App 分了 '+a.fields.length+' 格，但存的東西還是舊格式 —— 按「換金鑰」確認一次</div>' : '')
      +   '</div>'
      + '<div class="rc-acts">'
      +   '<button onclick="openKeyForm(\''+a.id+'\')">換金鑰</button>'
      +   '<button onclick="openKeyExpForm(\''+a.id+'\')">到期日</button>'
      +   '<button onclick="moveApp(\''+a.id+'\',\'up\',this)">↑</button>'
      +   '<button onclick="moveApp(\''+a.id+'\',\'down\',this)">↓</button>'
      +   '<button onclick="openAppEditForm(\''+a.id+'\')">編輯</button>'
      +   '<button onclick="openFieldsForm(\''+a.id+'\')">金鑰欄位</button>'
      +   '<button onclick="openSplashForm(\''+a.id+'\')">開場外觀</button>'
      +   '<button onclick="openPublicForm(\''+a.id+'\')">'+(a.public?'公開中':'公開')+'</button>'
      +   '<button onclick="openAppWho(\''+a.id+'\')">誰可以用</button>'
      +   '<button class="danger" onclick="askDeleteApp(\''+a.id+'\')">刪除</button>'
      + '</div></div>'
      + (repo
          ? '<button class="rc-open" onclick="toggleAppLog(\''+a.id+'\')">'+(open?"收起 ▴":"最近改了什麼 ▾")+'</button>'
            + (open ? '<div class="rc-log">'+(logRows
                ? (logRows.length ? '<ul>'+logRows.map(function(r){
                    return '<li><i>'+esc(agoOf(r.at))+'</i>'+esc(r.title)+'</li>'; }).join("")+'</ul>'
                  : '<p>這個 repo 還沒有 commit，或現在問不到 GitHub。</p>')
                : '<p>抓取中…</p>')+'</div>' : '')
          : '')
      + '</div>';
  }).join("");
  return '<div class="sec-title">App（'+S.apps.length+'）　順序就是啟動頁磚塊的排法</div>'+rows
    + '<button class="addcard" onclick="openAppForm()">＋ 登記新的 App</button>'
    + '<button class="loadmore" onclick="checkAllKeys(this)">🔄 重新檢查全部金鑰的到期日</button>';
}

/* 各 App 的「上次更新時間」：一個未認證的請求就拿得到全部（60 次/小時/IP）。
 * 跟啟動頁共用同一份 localStorage 快取（同一個鍵、同樣 30 分鐘）。 */
var PUSH_KEY = "keyring.launch.pushed";
var PUSH_TTL = 30*60*1000;
function loadPushed(force){
  PUSHED.tried = true;
  var cache=null;
  try{ cache=JSON.parse(localStorage.getItem(PUSH_KEY)||"null"); }catch(e){ cache=null; }
  if(!force && cache && cache.at && (Date.now()-cache.at)<PUSH_TTL){
    PUSHED.map=cache.map||{}; PUSHED.at=cache.at; render(); return Promise.resolve();
  }
  var owner=(S.apps.map(function(a){ return String(a.repo||a.repoGuess||"").split("/")[0]; })
    .filter(Boolean)[0])||"";
  if(!owner) return Promise.resolve();
  return fetch("https://api.github.com/users/"+encodeURIComponent(owner)+"/repos?sort=pushed&per_page=100",
    { headers:{ "Accept":"application/vnd.github+json" } })
    .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
    .then(function(list){
      var map={};
      (list||[]).forEach(function(x){ if(x&&x.full_name) map[x.full_name]=x.pushed_at; });
      PUSHED.map=map; PUSHED.at=Date.now();
      try{ localStorage.setItem(PUSH_KEY, JSON.stringify({at:PUSHED.at,map:map})); }catch(e){}
      render();
    }, function(){
      /* 拿不到更新時間不是錯誤：卡片照常，那一格顯示「—」 */
      if(cache){ PUSHED.map=cache.map||{}; PUSHED.at=cache.at; render(); }
    });
}
function toggleAppLog(id){
  OPENLOG[id]=!OPENLOG[id];
  render();
  if(OPENLOG[id] && !APPLOG[id]) loadAppLog(id);
}
function loadAppLog(id){
  var a=appById(id), repo=a && (a.repo||a.repoGuess);
  if(!repo){ APPLOG[id]=[]; return render(); }
  /* 未認證就好：這是公開資料，不必把任何金鑰送去 */
  return fetch("https://api.github.com/repos/"+repo+"/commits?per_page=3",
    { headers:{ "Accept":"application/vnd.github+json" } })
    .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
    .then(function(list){
      APPLOG[id]=(list||[]).map(function(c){
        return { at:(c.commit&&c.commit.author&&c.commit.author.date)||"",
                 title:String((c.commit&&c.commit.message)||"").split("\n")[0] };
      });
      render();
    }, function(){ APPLOG[id]=[]; render(); });
}

/* ---------- 近況（變更紀錄） ---------- */
function loadLog(n){
  LOG.busy=true; LOG.limit=n||30;
  return api("/history?limit="+LOG.limit).then(function(d){
    LOG.rows=d.entries||[]; LOG.err=d.message||""; LOG.busy=false; render();
  }).catch(function(e){ LOG.rows=[]; LOG.err=e.message; LOG.busy=false; render(); });
}
function dayLabel(iso){
  var t=Date.parse(iso||"");
  if(isNaN(t)) return "不知道什麼時候";
  var a=new Date(t), now=new Date();
  if(a.toDateString()===now.toDateString()) return "今天";
  if(a.toDateString()===new Date(now.getTime()-86400e3).toDateString()) return "昨天";
  return (a.getMonth()+1)+" 月 "+a.getDate()+" 日";
}
function clockOf(iso){
  var t=Date.parse(iso||"");
  if(isNaN(t)) return "";
  var d=new Date(t);
  return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
}
/* 跟手機後台同一種資料形狀、同一種畫法：{at,title,by,via,otherFiles} */
function logRowsHtml(rows){
  var h="", last="";
  rows.forEach(function(e){
    var d=dayLabel(e.at);
    if(d!==last){ h+=(last?"</ul>":"")+'<p class="day">'+esc(d)+'</p><ul class="tl">'; last=d; }
    var who = e.by ? esc(e.by)+"（"+esc(e.via)+"）" : esc(e.via);
    h+='<li>'
      + '<div class="w"><b>'+who+'</b><span>'+esc(clockOf(e.at))+'</span></div>'
      + '<div class="t">'+esc(e.title)+'</div>'
      + (e.otherFiles ? '<div class="x">這次同時改到 '+e.otherFiles+' 個其他檔案</div>' : '')
      + '</li>';
  });
  return h+(last?"</ul>":"");
}
function adLog(){
  if(LOG.busy && !LOG.rows) return '<div class="empty"><div class="big">🕘</div><p>正在讀 git 紀錄…</p></div>';
  if(!LOG.rows || !LOG.rows.length){
    return '<div class="empty"><div class="big">🕘</div><p>'+esc(LOG.err||"還沒有任何變更紀錄。")+'</p></div>';
  }
  return '<div class="sec-title">鑰匙圈被誰改過。存檔就是一筆紀錄，改不掉也刪不掉。</div>'
    + logRowsHtml(LOG.rows)
    + '<button class="loadmore" onclick="loadLog('+(LOG.limit+30)+')">看更早的</button>';
}

/* ---------- 🧰 工具（這台電腦上的程式） ---------- */
/* ⚠️ 這一整段只在電腦端的後台存在。啟動頁（GitHub Pages 的公開靜態頁）與手機後台
 *    都沒有這台電腦的 server，本機程式在那邊**永遠**啟動不了，所以那兩邊不放啟動鈕。 */
var TOOL_CATS = ["作品","AI 工具"];

function loadTools(){
  TOOLS.loading = true;
  return api("/tools").then(function(d){
    TOOLS.list = d.tools || [];
    TOOLS.file = d.file || {ok:true,message:""};
    TOOLS.err = ""; TOOLS.at = Date.now(); TOOLS.loading = false;
    render();
    scheduleToolChase();
  }).catch(function(e){
    TOOLS.list = TOOLS.list || [];
    TOOLS.err = e.message; TOOLS.loading = false; render();
  });
}
/* 有工具正在「啟動中」才追——啟動一個有 port 的工具要好幾秒才會亮綠燈。
 * 追完就停：不做常駐輪詢，免得整片畫面在他按按鈕的時候被重建。 */
function scheduleToolChase(){
  stopToolChase();
  if(adTab!=="tools"){ TOOLS.chase=0; return; }
  /* 還在啟動中就把追蹤次數補滿——重啟的空窗期第一次回來可能還沒變成 starting，
   * 以前寫成「不是 starting 就不追」，按了重啟之後畫面就停在那不動了。 */
  var starting = (TOOLS.list||[]).some(function(t){ return t.status==="starting"; });
  if(starting && TOOLS.chase<4) TOOLS.chase = 4;
  if(TOOLS.chase<=0) return;
  TOOLS.chase--;
  TOOLS.timer = setTimeout(function(){ TOOLS.timer=null; loadTools(); }, 2500);
}
function stopToolChase(){
  if(TOOLS.timer){ clearTimeout(TOOLS.timer); TOOLS.timer=null; }
}
function toolAct(id, action, btn){
  TOOLS.busy[id]=true;
  if(btn){ btn.disabled=true; }
  api("/tools/"+encodeURIComponent(id)+"/"+action,"POST").then(function(d){
    delete TOOLS.busy[id];
    toast({start:"啟動了",stop:"停掉了",restart:"重啟了"}[action]||"好了","ok");
    TOOLS.chase = 4;                       /* 最多再追 4 次（約 10 秒） */
    loadTools();
    if(TOOLS.openLog[id]) loadToolLog(id);
  }).catch(function(e){
    delete TOOLS.busy[id];
    toast(e.message,"err");
    TOOLS.chase = 0;
    loadTools();
  });
}
function toggleToolLog(id){
  TOOLS.openLog[id] = !TOOLS.openLog[id];
  render();
  if(TOOLS.openLog[id]) loadToolLog(id);
}
function loadToolLog(id){
  return api("/tools/"+encodeURIComponent(id)+"/logs").then(function(d){
    TOOLS.logs[id]=d.logs||[]; render();
  }).catch(function(){ TOOLS.logs[id]=[]; render(); });
}
/* 2026-09-03 重畫：狀態是這一頁唯一重要的東西，所以狀態變成卡片的顏色本身
 * （左側色條＋圖示底色＋一行狀態字），不是躲在一排灰chip裡的其中一顆。
 * 按鈕也不再四顆長一樣：每個狀態只留「現在真的能按的那一顆」當主鈕，
 * 其餘降成淡的次要鈕；不能按的直接不畫，不留一排死按鈕在那裡誤導人。 */
function toolStatusWord(t){
  if(t.status==="starting") return t.pending ? "重新啟動中…" : "啟動中…";
  if(t.status==="running")  return t.external ? "運行中（不是這裡開的）" : "運行中";
  return "沒在跑";
}
function toolCard(t){
  var busyNow = !!TOOLS.busy[t.id];
  var running = t.status!=="stopped";
  var open = !!TOOLS.openLog[t.id];
  var lines = TOOLS.logs[t.id];
  var acts = [];
  var B = function(cls,label,action,off,tip){
    return '<button class="tk-btn '+cls+'"'+(off?' disabled':'')
      + (tip?' title="'+esc(tip)+'"':'')
      + ' onclick="toolAct(\''+t.id+'\',\''+action+'\',this)">'+label+'</button>';
  };
  if(t.status==="stopped"){
    acts.push(B("go","▶ 啟動","start",busyNow));
  } else if(t.status==="starting"){
    acts.push('<button class="tk-btn go" disabled><i class="tk-spin"></i>啟動中</button>');
  } else {
    if(t.url) acts.push('<a class="tk-btn go" href="'+esc(t.url)+'" target="_blank" rel="noopener">開啟 ↗</a>');
    if(t.managed) acts.push(B("","↻ 重啟","restart",busyNow));
    if(t.stoppable) acts.push(B("bad","■ 停止","stop",busyNow));
  }
  return '<div class="tk-card is-'+t.status+(open?" open":"")+'">'
    + '<div class="tk-head">'
    +   '<div class="tk-face">'+esc(t.emoji)+'</div>'
    +   '<div class="tk-bd">'
    +     '<b>'+esc(t.name)+'</b>'
    +     '<span class="tk-desc">'+esc(t.description||"")+'</span>'
    +     '<span class="tk-state"><i class="tk-dot '+t.status+'"></i>'+esc(toolStatusWord(t))
    +       (t.port||t.pid ? '<em>'
    +          (t.port ? "port "+esc(String(t.port)) : "")
    +          (t.port&&t.pid ? " · " : "")
    +          (t.pid ? "pid "+esc(String(t.pid)) : "") + '</em>' : '')
    +     '</span>'
    +   '</div>'
    + '</div>'
    + (t.external && !t.stoppable
        ? '<div class="tk-note">這個是外面開的、又沒有 PID 可以認，只能去原本那個視窗關掉</div>' : '')
    /* 按鈕自己一排：擠在標題右邊的話，兩欄版的標題只剩一百多 px，字會被切掉 */
    + '<div class="tk-foot">'
    +   '<button class="tk-more" onclick="toggleToolLog(\''+t.id+'\')">'
    +     (open?"收起輸出 ▴":"看它印了什麼 ▾")+'</button>'
    +   '<div class="tk-acts">'+acts.join("")+'</div>'
    + '</div>'
    + (open ? '<div class="tk-log">'+(lines
        ? (lines.length ? '<pre>'+esc(lines.join("\n"))+'</pre>'
                        : '<p>還沒有東西。只有從這裡啟動的工具才會留下輸出。</p>')
        : '<p>讀取中…</p>')+'</div>' : '')
    + '</div>';
}
function adTools(){
  var foot = '<div class="ad-foot">'
    + '這一頁只有電腦上的後台有。手機與啟動頁沒有這台電腦的 server，本機程式在那邊打不開。<br>'
    + '鑰匙圈自己不在清單裡 —— 你現在用的就是它。<br>'
    + '清單在 <code>tools.local.json</code>（只留在這台電腦，不會被發布出去）。改完按重新整理就好。'
    + '</div>';
  /* 「有沒有資料」與「畫不畫面」解耦：問不到狀態時把原本那份清單留在畫面上，
   * 只在上面加一條說「這是舊的」，不要整頁塌掉。 */
  var errBar = TOOLS.err
    ? '<div class="pub-bar bad"><div class="pub-txt"><b>問不到工具狀態</b>'
      + '<span>'+esc(TOOLS.err)+(TOOLS.at?'　下面這些是 '+esc(clockOf(new Date(TOOLS.at).toISOString()))+' 的舊狀態。':'')+'</span></div>'
      + '<div class="pub-acts"><button class="pub-btn" onclick="loadTools()">再試一次</button></div></div>'
    : '';
  if(TOOLS.err && (!TOOLS.list || !TOOLS.list.length)) return errBar + foot;
  if(TOOLS.list===null) return '<div class="empty"><div class="big">🧰</div><p>正在看這些工具跑了沒…</p></div>';
  if(TOOLS.file && TOOLS.file.ok===false){
    return '<div class="pub-bar bad"><div class="pub-txt"><b>讀不到工具清單</b><span>'+esc(TOOLS.file.message||"")+'</span></div>'
      + '<div class="pub-acts"><button class="pub-btn" onclick="loadTools()">再讀一次</button></div></div>' + foot;
  }
  if(!TOOLS.list.length){
    return '<div class="empty"><div class="big">🧰</div><p>清單裡一個工具都沒有。<br>'
      + '把它們寫進 <code>tools.local.json</code> 就會出現在這裡。</p></div>' + foot;
  }
  var cats = [];
  TOOLS.list.forEach(function(t){ var c=t.category||"其他"; if(cats.indexOf(c)<0) cats.push(c); });
  cats.sort(function(a,b){
    var ia=TOOL_CATS.indexOf(a), ib=TOOL_CATS.indexOf(b);
    return (ia<0?99:ia)-(ib<0?99:ib);
  });
  var body = cats.map(function(c){
    var mine = TOOLS.list.filter(function(t){ return (t.category||"其他")===c; });
    return '<div class="sec-title">'+esc(c)+'（'+mine.length+'）</div>'
      + '<div class="tk-grid">' + mine.map(toolCard).join("") + '</div>';
  }).join("");
  var upd = TOOLS.at ? "狀態是 "+clockOf(new Date(TOOLS.at).toISOString())+" 抓的" : "";
  return errBar + '<div class="tk-bar"><span>'+esc(upd)+'</span>'
    + '<button onclick="loadTools()">🔄 重新整理</button></div>'
    + body + foot;
}

/* ---------- 金鑰到期日 ---------- */
function checkAllKeys(btn){
  busy(btn, "檢查中…");
  api("/apps/checkkeys","POST").then(function(d){
    applyState(d);
    toast((d.lines&&d.lines.length) ? d.lines.join("；") : "沒有金鑰可以檢查", "ok");
  }).catch(function(e){ toast(e.message,"err"); render(); });
}
function openKeyExpForm(id){
  var a=appById(id), st=a.key||{state:"unknown"};
  var repo=a.repo||a.repoGuess||"";
  var box="";
  if(st.state==="expired"){
    box='<div class="expbox"><b>這把已經過期了</b>它現在存不了東西，而且不會跳錯誤——'
      + 'App 看起來一切正常，資料就是沒進去。</div>';
  } else if(st.state==="soon"){
    box='<div class="expbox"><b>還有 '+st.days+' 天</b>到期日是 GitHub 自己回報的，不是我填的。</div>';
  }
  formState={id:id};
  openDialog('<div class="sheet-head"><h3>「'+esc(a.name)+'」的金鑰到期日</h3>'
    + '<button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + box
    + '<div class="hint" style="margin-top:0">現在：<b>'+esc(KF.keyLabel(st))+'</b>'
    +   (st.expiresAt ? '（'+esc(st.expiresAt)+'，'+(st.source==="manual"?"自己填的":"GitHub 回報的")+'）' : '')
    +   (st.checkedAt ? '<br>上次檢查 '+esc(fmtTime(st.checkedAt)) : '<br>還沒檢查過')
    +   '<br>檢查是拿<b>這個 App 自己那把金鑰</b>去問 '+esc(repo||"GitHub")+'，不會用到別的 App 的。</div>'
    + '<label class="field"><span class="fl">自己填一個日期（選填，備援用）</span>'
    +   '<input id="ke-date" type="text" inputmode="numeric" placeholder="2026-12-02" value="'
    +   esc(st.source==="manual"&&st.expiresAt?st.expiresAt:"")+'"></label>'
    + '<div class="hint">自動測得到的時候會蓋掉它 —— 自動比人記得準。留空＝清掉。</div>'
    + '<button class="btn-primary" onclick="checkOneKey(\''+id+'\',this)" style="margin-bottom:10px">重新檢查</button>'
    + '<button class="btn-ghost" onclick="saveKeyExp(\''+id+'\',this)">存我填的日期</button>');
}
function checkOneKey(id, btn){
  busy(btn, "問 GitHub…");
  api("/apps/"+encodeURIComponent(id)+"/checkkey","POST").then(function(d){
    applyState(d); closeSheet(); toast(d.message||"檢查完了","ok");
  }).catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="重新檢查"; } });
}
function saveKeyExp(id, btn){
  var v=($("ke-date").value||"").trim();
  busy(btn);
  api("/apps/"+encodeURIComponent(id)+"/keyexp","POST",{expiresAt:v})
    .then(function(d){ applyState(d); closeSheet(); toast(v?"存好了":"清掉了","ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="存我填的日期"; } });
}
/* 啟動頁磚塊的位置（固定順序是 Benson 拍板的，不做「最近更新排前面」） */
function moveApp(id, dir, btn){
  if(btn) btn.disabled=true;
  api("/apps/"+encodeURIComponent(id)+"/move","POST",{dir:dir})
    .then(applyState)
    .catch(function(e){ toast(e.message,"err"); render(); });
}

/* ---------- 多欄位金鑰（共用邏輯在 client/keyring-fields.js） ----------
 * 沒有宣告欄位的 App（旅途手帳、食譜本）完全走原本那條路，這裡的東西一行都不會執行。 */
var KF = window.KeyringFields;

/* 欄位宣告的編輯器（登記 App 與「金鑰欄位」都用這一段）。
 * formState.fields = [{key,label,hint,optional}] */
function fieldsEditorHtml(){
  var fs = formState.fields || [];
  var rows = fs.map(function(f,i){
    return '<div class="fieldrow" data-i="'+i+'">'
      + '<div class="fr-line">'
      +   '<input class="fr-key" placeholder="代號 tmdb" value="'+esc(f.key)+'" autocapitalize="off" spellcheck="false"'
      +     ' oninput="fieldSet('+i+',\'key\',this.value)">'
      +   '<input class="fr-label" placeholder="'
      +     (f.labelHidden ? '原本的標題像金鑰、已隱藏——請改成人看的名字' : '標題（TMDB 金鑰）')
      +     '" value="'+esc(f.labelHidden ? '' : f.label)+'"'
      +     ' oninput="fieldSet('+i+',\'label\',this.value)">'
      +   '<button type="button" class="fr-del" onclick="fieldDel('+i+')" aria-label="刪掉這一格">✕</button>'
      + '</div>'
      + '<div class="fr-line">'
      /* hintHidden＝這格原本的說明看起來像金鑰，已經被 API 遮掉。這裡要給**空字串**
       * 而不是遮罩後的警告文字，否則一存檔就把警告字串當成他的說明寫回去、
       * 把原本那串（很可能是他金鑰的唯一副本）蓋掉。 */
      +   '<input class="fr-hint" placeholder="'
      +     (f.hintHidden ? '原本的說明像金鑰、已隱藏——存檔會清掉它' : '說明（選填，會顯示在輸入框下面）')
      +     '" value="'+esc(f.hintHidden ? '' : f.hint)+'"'
      +     ' oninput="fieldSet('+i+',\'hint\',this.value)">'
      +   '<label class="fr-opt"><input type="checkbox" '+(f.optional?"checked":"")
      +     ' onchange="fieldSet('+i+',\'optional\',this.checked)"> 可以留空</label>'
      + '</div></div>';
  }).join("");
  /* 代號對得上就給那個 App 的現成組合；還沒設任何格子時也給一個現成的當範例 */
  var preset = KF.presetFor(($("af-id") && $("af-id").value.trim()) || formState.appId || "")
    || (fs.length ? null : KF.PRESETS[0]);
  return '<div class="field"><span class="fl">金鑰要分成幾格</span>'
    + '<div class="hint" style="margin-top:0">不設就是一格（現在旅途手帳、食譜本都是這樣，畫面完全不變）。'
    + '需要兩把金鑰的 App（例如好雷嗎的 TMDB＋OMDb）就加兩格，後台會幫你組成 App 讀得懂的格式。'
    /* ⚠️ 這句是踩兩次換來的：這張表單只有代號／標題／說明，**沒有放值的地方**，
     *    所以人會很自然地把金鑰填進最像的那一格（第一次填進說明、第二次填進標題）。
     *    講清楚它在做什麼、金鑰要去哪填，比事後擋下來重要。 */
    + '<br><b>這裡只是宣告「有哪幾格」，不是填金鑰的地方</b>——'
    + '存完之後在那一列按「換金鑰」才是貼金鑰的地方。</div>'
    + '<div id="fieldrows">'+rows+'</div>'
    + '<div class="fr-acts">'
    +   (fs.length < KF.MAX_FIELDS ? '<button type="button" onclick="fieldAdd()">＋ 加一格</button>' : '')
    +   (preset ? '<button type="button" onclick="fieldPreset(\''+esc(preset.id)+'\')">套用「'+esc(preset.label)+'」</button>' : '')
    +   (fs.length ? '<button type="button" onclick="fieldClear()">改回一格</button>' : '')
    + '</div></div>';
}
function fieldSet(i,k,v){ if(formState.fields && formState.fields[i]) formState.fields[i][k]=v; }
function fieldAdd(){ formState.fields=(formState.fields||[]).concat([{key:"",label:"",hint:"",optional:false}]); formRedraw(); }
function fieldDel(i){ formState.fields.splice(i,1); formRedraw(); }
function fieldClear(){ formState.fields=[]; formRedraw(); }
function fieldPreset(id){
  var p=KF.presetFor(id);
  if(p) formState.fields=JSON.parse(JSON.stringify(p.fields));
  formRedraw();
}
/* 重畫之前先把使用者已經打進去的字收進 formState，不然加一格會把他打的東西清掉 */
function formRedraw(){
  if(formState.mode==="app"){
    if($("af-name")) formState.name=$("af-name").value;
    if($("af-id")) formState.appId=$("af-id").value;
    if($("af-url")) formState.url=$("af-url").value;
    if($("af-repo")) formState.repo=$("af-repo").value;
    if($("af-key")) formState.token=$("af-key").value;
    drawAppForm();
  } else if(formState.mode==="fields"){
    drawFieldsForm();
  }
}

/* ---------- dialog 基礎 ---------- */
function openDialog(html, focusId){
  var layer=$("sheet-layer"); layer.hidden=false;
  layer.innerHTML='<div class="backdrop" onclick="closeSheet()"></div><div class="dialog">'+html+'</div>';
  if(focusId) setTimeout(function(){ var el=$(focusId); if(el) el.focus(); }, 60);
}
function closeSheet(){ var l=$("sheet-layer"); l.hidden=true; l.innerHTML=""; }
function busy(btn, txt){ if(btn){ btn.disabled=true; btn.textContent=txt||"存檔中…"; } }

/* ---------- 使用者表單 ---------- */
/* 欄位順序：名字 → 頭像 → 顏色 → 可以用哪些 App → 密碼（DESIGN.md B2，密碼刻意放最後） */
function pwHint(v){
  if(!v) return "";
  if(v.length<4) return "這組很短，記得住就好——存得下去。";
  if(/^\d+$/.test(v) && v.length<7) return "全是數字，有點好猜——不擋你，想清楚就好。";
  return "看起來可以。";
}
function livePw(){
  var v=$("uf-pw") ? $("uf-pw").value : "";
  var m=$("uf-pwhint"); if(!m) return;
  var h=pwHint(v);
  m.textContent=h;
  m.className="pw-meter"+(h && h!=="看起來可以。" ? " weak":"");
}
function openUserForm(id){
  var u = id ? userById(id) : null;
  formState = {
    id: id, name:u?u.name:"", emoji:u?u.emoji:"🧑", theme:u?u.theme:"night",
    apps:u?u.apps.slice():S.apps.map(function(a){return a.id;}), show:false  /* 新增時預設全勾 */
  };
  drawUserForm();
}
function drawUserForm(){
  var f=formState, isNew=!f.id;
  var emojiPicks = EMOJIS.map(function(e){
    return '<label class="pick"><input type="radio" name="ufe" '+(f.emoji===e?"checked":"")
      + ' onchange="formState.emoji=\''+e+'\'"><span>'+e+'</span></label>';
  }).join("");
  var themePicks = THEME_KEYS.map(function(k){
    return '<label class="pick"><input type="radio" name="uft" '+(f.theme===k?"checked":"")
      + ' onchange="formState.theme=\''+k+'\'"><span class="swatch" style="background:'+THEMES[k]+'"></span></label>';
  }).join("");
  var appChecks = S.apps.length ? S.apps.map(function(a){
    var on = f.apps.indexOf(a.id)>=0;
    return '<label class="appcheck"><input type="checkbox" '+(on?"checked":"")
      + ' onchange="toggleFormApp(\''+a.id+'\',this.checked)">'
      + '<span class="em">'+a.emoji+'</span>'
      + '<span class="nm">'+esc(a.name)+'<small>'+esc((a.url||"").replace(/^https?:\/\//,""))+'</small></span>'
      + '<span class="ck-box"></span></label>';
  }).join("") : '<div class="hint" style="margin:0">還沒登記任何 App，先到「📦 App 金鑰」登記一個。</div>';
  openDialog(
    '<div class="sheet-head"><h3>'+(isNew?"新增使用者":"編輯 "+esc(f.name))+'</h3>'
    + '<button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<label class="field"><span class="fl">名字</span>'
    +   '<input id="uf-name" value="'+esc(f.name)+'" placeholder="他要看到的名字" autocomplete="off"></label>'
    + '<div class="field"><span class="fl">頭像</span><div class="pickrow">'+emojiPicks+'</div></div>'
    + '<div class="field"><span class="fl">顏色</span><div class="pickrow">'+themePicks+'</div></div>'
    + '<div class="field"><span class="fl">可以用哪些 App</span><div class="applist">'+appChecks+'</div></div>'
    + (isNew
        ? '<label class="field"><span class="fl">密碼</span><div class="pw-wrap">'
          + '<input id="uf-pw" type="'+(f.show?"text":"password")+'" placeholder="他要輸入的密碼" '
          + 'autocomplete="new-password" autocapitalize="off" spellcheck="false" oninput="livePw()">'
          + '<button type="button" class="pw-eye" onclick="toggleFormPw()" aria-label="顯示密碼">'+(f.show?"🙈":"👁")+'</button>'
          + '</div><div class="pw-meter" id="uf-pwhint"></div></label>'
          + '<div class="hint">短的、好記的都行，這裡不擋。設好之後親口告訴他就可以。</div>'
        : '<div class="hint">密碼要改的話，用列表上的「換密碼」。</div>')
    + '<button class="btn-primary" onclick="saveUser(this)">'+(isNew?"建立":"儲存")+'</button>',
    "uf-name");
}
function toggleFormApp(id, on){
  var i=formState.apps.indexOf(id);
  if(on && i<0) formState.apps.push(id);
  if(!on && i>=0) formState.apps.splice(i,1);
}
function toggleFormPw(){
  var v=$("uf-pw")?$("uf-pw").value:"";
  formState.name = $("uf-name") ? $("uf-name").value : formState.name;
  formState.show=!formState.show; drawUserForm();
  if($("uf-pw")){ $("uf-pw").value=v; $("uf-pw").focus(); livePw(); }
}
function saveUser(btn){
  var f=formState;
  var name=($("uf-name").value||"").trim();
  if(!name){ toast("先幫他取個名字", "err"); $("uf-name").focus(); return; }
  var pw = f.id ? "" : (($("uf-pw")||{}).value||"");
  if(!f.id && !pw){ toast("先設一組密碼給他", "err"); $("uf-pw").focus(); return; }
  busy(btn);
  api("/users","POST",{id:f.id, name:name, emoji:f.emoji, theme:f.theme, apps:f.apps, password:pw})
    .then(function(d){
      applyState(d);
      if(f.id){ closeSheet(); toast("存好了","ok"); }
      else{ showHandover(userById(d.userId), pw, "建立好了"); }
    })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent=f.id?"儲存":"建立"; } });
}

/* 建好之後：怎麼告訴對方（同一個畫面也用在「換密碼成功」） */
function sayText(u, pw){
  var ap = u && u.apps.length ? appById(u.apps[0]) : null;
  var url = ap && ap.url ? ap.url : "（App 網址）";
  var nm  = ap ? ap.name : "App";
  return nm+"可以編輯囉：\n"
    + "1. 打開 "+url+"\n"
    + "2. 點最下面那條「只看看模式・點我解鎖」\n"
    + "3. 選「"+(u?u.name:"")+"」，密碼是 "+pw+"\n"
    + "之後這支手機就記住了，下次打開直接能改。";
}
function showHandover(u, pw, title){
  if(!u){ closeSheet(); return; }
  var txt=sayText(u,pw);
  openDialog(
    '<div class="sheet-head"><h3>'+esc(title)+'</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="okbox"><b>'+u.emoji+' '+esc(u.name)+' 的鑰匙已經配好</b>'
    +   '<p>'+((S.publish&&S.publish.ok)
              ? '已經自動發布出去了，他那邊打開就拿得到。'
              : '本機存好了，但還沒發布出去——上面那條「再試一次」成功之後他才拿得到。')+'</p></div>'
    + '<div class="sec-title" style="margin-left:0">告訴他的話（可以直接傳）</div>'
    + '<div class="saytext" id="say-text">'+esc(txt)+'</div>'
    + '<div class="hint">這段話裡有密碼，傳完記得把訊息刪掉。</div>'
    + '<button class="btn-ghost" onclick="copySay()" style="margin-bottom:10px">📋 複製這段話</button>'
    + '<button class="btn-primary" onclick="closeSheet()">好</button>');
}
function copySay(){
  var t=$("say-text").textContent;
  function ok(){ toast("複製好了，貼給他就行", "ok"); }
  function fallback(){
    var ta=document.createElement("textarea"); ta.value=t;
    ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand("copy"); ok(); }catch(e){ toast("複製不了，長按上面那段自己選吧", "err"); }
    document.body.removeChild(ta);
  }
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, fallback);
  else fallback();
}

/* ---------- 換密碼 ---------- */
function openPwForm(id){ formState={id:id, show:false}; drawPwForm(userById(id)); }
function drawPwForm(u){
  openDialog(
    '<div class="sheet-head"><h3>幫 '+esc(u.name)+' 換密碼</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="hint" style="margin-top:0">舊密碼看不到也想不起來，直接給一組新的就好。</div>'
    + '<label class="field"><span class="fl">新密碼</span><div class="pw-wrap">'
    +   '<input id="uf-pw" type="'+(formState.show?"text":"password")+'" placeholder="新的密碼" '
    +   'autocomplete="new-password" autocapitalize="off" spellcheck="false" oninput="livePw()">'
    +   '<button type="button" class="pw-eye" onclick="togglePwForm(\''+u.id+'\')" aria-label="顯示密碼">'+(formState.show?"🙈":"👁")+'</button>'
    + '</div><div class="pw-meter" id="uf-pwhint"></div></label>'
    + '<div class="warnbox">換了之後，他已經解鎖過的裝置會回到「只看看」，要用新密碼再解一次。</div>'
    + '<button class="btn-primary" onclick="savePw(\''+u.id+'\', this)">換成這組</button>',
    "uf-pw");
}
function togglePwForm(id){
  var v=$("uf-pw")?$("uf-pw").value:"";
  formState.show=!formState.show; drawPwForm(userById(id));
  if($("uf-pw")){ $("uf-pw").value=v; $("uf-pw").focus(); livePw(); }
}
function savePw(id, btn){
  var pw=$("uf-pw").value||"";
  if(!pw){ toast("先輸入新密碼", "err"); return; }
  busy(btn, "換密碼中…");
  api("/users/"+encodeURIComponent(id)+"/password","POST",{password:pw})
    .then(function(d){ applyState(d); showHandover(userById(id), pw, "密碼換好了"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="換成這組"; } });
}

/* ---------- 刪使用者 ---------- */
function askDeleteUser(id){
  var u=userById(id);
  openDialog('<div class="sheet-head"><h3>要刪掉 '+esc(u.name)+' 嗎？</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="warnbox">刪掉之後他就不能再編輯了（已經打開的裝置，下次重整就變成只看看）。</div>'
    + '<button class="btn-danger" onclick="doDeleteUser(\''+id+'\', this)" style="margin-bottom:10px">刪掉</button>'
    + '<button class="btn-ghost" onclick="closeSheet()">算了</button>');
}
function doDeleteUser(id, btn){
  busy(btn, "刪除中…");
  api("/users/"+encodeURIComponent(id),"DELETE")
    .then(function(d){ applyState(d); closeSheet(); toast("刪掉了"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="刪掉"; } });
}

/* ---------- App 金鑰 ---------- */
function openAppForm(){
  /* kind＝先決定這個 App 要不要金鑰。只放連結的 App 不產密文、不掛在任何成員底下。
   * 不存 linkOnly 旗標——「有沒有金鑰」從 token 是不是空的推導就好（少一個會分岔的真相來源）。 */
  formState={mode:"app", emoji:"📦", fields:[], name:"", appId:"", url:"", repo:"", token:"", kind:"link"};
  drawAppForm();
}
function openAppEditForm(id){
  var a=appById(id);
  formState={mode:"app", editId:id, emoji:a.emoji, fields:[], name:a.name, appId:a.id,
             url:a.url||"", repo:a.repo||"", token:"", kind:a.keyed?"key":"link"};
  drawAppForm();
}
function drawAppForm(){
  var edit=!!formState.editId;
  var picks = APP_EMOJIS.map(function(e){
    return '<label class="pick"><input type="radio" name="afe" '+(formState.emoji===e?"checked":"")
      + ' onchange="formState.emoji=\''+e+'\'"><span>'+e+'</span></label>';
  }).join("");
  var kind = edit ? '' :
    '<div class="kind">'
    + '<button type="button" class="'+(formState.kind==="link"?"on":"")+'" onclick="pickKind(\'link\')">'
    +   '<span class="ke">🔗</span><span><b>只放連結</b>'
    +   '<span>只是想在啟動頁按一下就開它。不會出現在解鎖名單裡。</span></span></button>'
    + '<button type="button" class="'+(formState.kind==="key"?"on":"")+'" onclick="pickKind(\'key\')">'
    +   '<span class="ke">🔑</span><span><b>連結＋金鑰</b>'
    +   '<span>這個 App 要存東西回 GitHub。登記完會直接把貼金鑰的畫面端出來。</span></span></button>'
    + '</div>';
  openDialog('<div class="sheet-head"><h3>'+(edit?'改「'+esc(formState.name)+'」':'登記新的 App')+'</h3>'
    + '<button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + kind
    + '<label class="field"><span class="fl">App 名稱</span><input id="af-name" placeholder="例：旅途手帳" value="'+esc(formState.name||"")+'"></label>'
    + (edit
        ? '<div class="field"><span class="fl">代號</span><div class="keyline">'+esc(formState.appId)+'</div></div>'
          + '<div class="hint">代號登記好就不能改（App 前端是照它去找金鑰的）。</div>'
        : '<label class="field"><span class="fl">代號（App 程式裡用的 id）</span>'
          + '<input id="af-id" placeholder="例：travel-book" autocapitalize="off" spellcheck="false" value="'+esc(formState.appId||"")+'"'
          + ' oninput="formState.appId=this.value" onchange="formRedraw()"></label>'
          + '<div class="hint">要跟那個 App 前端設定的 appId 一模一樣，留空就用名字自動產生。</div>')
    + '<div class="field"><span class="fl">圖示</span><div class="pickrow">'+picks+'</div></div>'
    + '<label class="field"><span class="fl">網址</span>'
    +   '<input id="af-url" placeholder="https://xd1104.github.io/…" inputmode="url" autocapitalize="off" spellcheck="false" value="'+esc(formState.url||"")+'"></label>'
    + '<div class="hint">啟動頁的磚塊就是靠它開 App。</div>'
    + '<label class="field"><span class="fl">GitHub repo（選填）</span>'
    +   '<input id="af-repo" placeholder="xd1104/travel-book" autocapitalize="off" spellcheck="false" value="'+esc(formState.repo||"")+'"></label>'
    + '<div class="hint">拿來顯示「上次更新時間」。留空就從網址猜（猜不到就顯示「—」，不會亂猜）。</div>'
    + (edit ? '' : fieldsEditorHtml())
    + (edit || (formState.fields||[]).length || formState.kind==="link"
        ? ((formState.fields||[]).length
            ? '<div class="hint">登記好之後在那一列按「換金鑰」就會看到 '+(formState.fields.length)+' 格，一格一把貼進去。</div>'
            : '')
        : '<label class="field"><span class="fl">GitHub 金鑰（選填）</span>'
          + '<input id="af-key" type="password" placeholder="留空＝登記完再貼" autocomplete="off" spellcheck="false" value="'+esc(formState.token||"")+'"></label>'
          /* ⛔ 這裡以前寫「留空就沿用現在這把」而且真的會抄過來 —— 那等於讓金鑰在 App
           * 之間流動，違反鐵律：每個 App 一把、只授權它自己那一個 repo。不要改回去。 */
          + '<div class="hint">fine-grained PAT，只授權那一個 repo 的 Contents。'
          + '<b>刻意不從別的 App 沿用</b>——每個 App 一把。明文只留在這台電腦。</div>')
    + '<button class="btn-primary" onclick="saveApp(this)">'+(edit?'存起來':'登記')+'</button>', "af-name");
}
function pickKind(k){
  formState.kind=k;
  formRedraw();
}
function saveApp(btn){
  var edit=!!formState.editId;
  var n=($("af-name").value||"").trim(), id=edit ? formState.editId : ($("af-id").value||"").trim();
  var u=($("af-url").value||"").trim(), k=($("af-key") ? ($("af-key").value||"").trim() : "");
  var repo=($("af-repo") ? ($("af-repo").value||"").trim() : "");
  if(!n){ toast("先給它一個名字", "err"); return; }
  if(repo && !KF.normRepo(repo)){ toast("GitHub repo 要寫成 xd1104/travel-book 這種樣子","err"); return; }
  var fields = KF.normFields(formState.fields||[]);
  if((formState.fields||[]).length && !fields.length){
    toast("那幾格的代號還沒填（只能用英文小寫，例如 tmdb）", "err"); return;
  }
  busy(btn, edit ? "存檔中…" : "登記中…");
  var body = {name:n, emoji:formState.emoji, url:u, repo:repo, token:k, kind:formState.kind};
  if(edit) body.id=id; else { body.appId=id; body.fields=fields; }
  api("/apps","POST",body)
    .then(function(d){
      applyState(d); closeSheet();
      /* ⭐ 登記完**直接把填金鑰的畫面端出來**（2026-08-24 加）。
       * 分格的 App 在登記表單裡根本沒有放值的地方（那張表單只有代號／標題／說明），
       * 所以「登記好了」之後他會站在一個沒有金鑰的 App 前面，而唯一能填的入口是
       * 列表上那顆「換金鑰」——實際發生過：找不到，於是把金鑰填進說明、再填進標題。
       * 與其事後擋，不如把下一步直接遞到他面前。 */
      if (edit) { toast("存好了","ok"); return; }
      var made = d && d.appId ? appById(d.appId) : null;
      /* 只放連結的 App 沒有金鑰要填，不要硬把貼金鑰的畫面塞給他 */
      if (made && !made.hasToken && formState.kind === "key") {
        toast("登記好了，接著把金鑰填進來","ok"); openKeyForm(made.id); return;
      }
      toast(made && made.hasToken ? "登記好了，現有的人都已經可以用了" : "登記好了，啟動頁上就看得到它了","ok");
    })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent=edit?"存起來":"登記"; } });
}
function openKeyForm(id){
  var a=appById(id);
  /* 多欄位的 App：只拿得到**每格的遮罩**（後台不吐明文，見 server.js 的 viewState）。
     所以是「留空＝不改這一格」，跟單欄位那條路同一個方向：只進不出。 */
  if((a.fields||[]).length){
    formState={mode:"key", id:id, fields:a.fields, masked:a.fieldsMasked||[], parsed:a.fieldsOk!==false, clear:[]};
    drawKeyFormMulti(a);
    return;
  }
  openDialog('<div class="sheet-head"><h3>換「'+esc(a.name)+'」的金鑰</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="hint" style="margin-top:0">目前：<span class="keyline">'+esc(a.masked||"（還沒有金鑰）")+'</span></div>'
    + '<label class="field"><span class="fl">新的金鑰</span>'
    +   '<input id="kf-key" type="password" placeholder="github_pat_…" autocomplete="off" spellcheck="false"></label>'
    + '<div class="warnbox">換金鑰不用改任何人的密碼，發布之後大家自動換到新的。</div>'
    + '<button class="btn-primary" onclick="saveKey(\''+id+'\', this)">換上去</button>', "kf-key");
}
function drawKeyFormMulti(a){
  var fs=formState.fields, mk=formState.masked;
  var boxes=fs.map(function(f,i){
    var m=mk[i]||{};
    var now = m.filled ? '目前 <span class="keyline">'+esc(m.masked)+'</span>，留空＝不改這一格'
                       : '目前還沒填';
    return '<label class="field"><span class="fl">'+esc(f.label)+(f.optional?'（可留空）':'')+'</span>'
      + '<input id="kf-'+i+'" type="password" autocomplete="off" spellcheck="false" autocapitalize="off"'
      +   ' placeholder="'+(m.filled?'留空就不動它':'貼上金鑰')+'">'
      /* ⚠️ 說明**另起一行**，不要跟「目前 …」黏在同一行：黏在一起時它讀起來像
       *    第二個「目前的值」，同一格會出現兩個對不起來的現況（實際被回報過）。
       *    safeHint() 另外擋掉「說明欄裡放了金鑰」那種情況。 */
      + '<span class="hint">'+now+'</span>'
      + (f.hint ? '<span class="hint">'+esc(KF.safeHint(f.hint))+'</span>' : '')
      + (m.filled && f.optional
          ? '<label class="fr-opt" style="margin-top:6px"><input type="checkbox" id="kc-'+i+'"> 清掉這一格</label>'
          : '')
      + '</label>';
  }).join("");
  openDialog('<div class="sheet-head"><h3>「'+esc(a.name)+'」的金鑰</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + (formState.parsed ? ''
        : '<div class="warnbox">這個 App 存的還是舊格式（一整串）。上面第一格顯示的就是那一串，'
          + '把它換成正確的值再存一次就好 —— 在你按存檔之前，原本的東西一個字都不會動。</div>')
    + boxes
    + '<div class="warnbox">換金鑰不用改任何人的密碼，發布之後大家自動換到新的。</div>'
    + '<button class="btn-primary" onclick="saveKeyMulti(this)">存起來</button>', "kf-0");
}
function saveKeyMulti(btn){
  var fs=formState.fields, mk=formState.masked, values={}, clear=[], touched=false;
  for(var i=0;i<fs.length;i++){
    var el=$("kf-"+i), v=el ? (el.value||"").trim() : "";
    var cl=$("kc-"+i) && $("kc-"+i).checked;
    if(v){ values[fs[i].key]=v; touched=true; }
    if(cl){ clear.push(fs[i].key); touched=true; }
    /* 必填：現在沒有、這次也沒打 → 先擋下來，不要送出去等 server 罵 */
    if(!fs[i].optional && !v && !(mk[i]&&mk[i].filled)){ toast("「"+fs[i].label+"」還沒填","err"); return; }
    if(!fs[i].optional && cl){ toast("「"+fs[i].label+"」是必填的，不能清掉","err"); return; }
  }
  if(!touched){ toast("沒有改到任何一格","err"); return; }
  busy(btn, "存檔中…");
  api("/apps/"+encodeURIComponent(formState.id)+"/token","POST",{values:values, clear:clear})
    .then(function(d){ applyState(d); closeSheet(); toast("存好了","ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="存起來"; } });
}
function saveKey(id, btn){
  var k=($("kf-key").value||"").trim();
  if(!k){ toast("先貼上新的金鑰", "err"); return; }
  busy(btn, "換金鑰中…");
  api("/apps/"+encodeURIComponent(id)+"/token","POST",{token:k})
    .then(function(d){ applyState(d); closeSheet(); toast("換好了","ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="換上去"; } });
}

/* ---------- 事後改欄位設定（既有的 App 從一格改成幾格） ---------- */
function openFieldsForm(id){
  var a=appById(id);
  formState={mode:"fields", id:id, appId:id, fields:JSON.parse(JSON.stringify(a.fields||[]))};
  drawFieldsForm();
}
function drawFieldsForm(){
  var a=appById(formState.id);
  openDialog('<div class="sheet-head"><h3>「'+esc(a.name)+'」的金鑰欄位</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + fieldsEditorHtml()
    + '<div class="warnbox">存下去的時候，原本那串會<b>自動拆進各格</b>（拆不開的話一個字都不會動，'
    +   '會標成「格式待確認」，等你自己填新的）。你貼過的東西不會不見。</div>'
    + '<button class="btn-primary" onclick="saveFields(this)">存起來</button>');
}
function saveFields(btn){
  var fields=KF.normFields(formState.fields||[]);
  if((formState.fields||[]).length && !fields.length){
    toast("那幾格的代號還沒填（只能用英文小寫，例如 tmdb）", "err"); return;
  }
  busy(btn);
  api("/apps/"+encodeURIComponent(formState.id)+"/fields","POST",{fields:fields})
    .then(function(d){ applyState(d); closeSheet();
      toast(!fields.length ? "改回一格了" : (d.migrated ? "設好了，原本那串已經拆進各格" : "設好了，接著按「換金鑰」把各格填一填"),"ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="存起來"; } });
}
/* ---------- 公開模式（打開網址就能用，沒有登入畫面） ---------- */
function openPublicForm(id){
  var a=appById(id);
  var on=!!a.public;
  openDialog('<div class="sheet-head"><h3>「'+esc(a.name)+'」要公開嗎？</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="warnbox">'+esc(KF.PUBLIC_WARNING).replace(/\*\*(.+?)\*\*/g,"<b>$1</b>")+'</div>'
    + '<p class="sub">公開之後：任何人打開那個 App 的網址就能用，<b>不需要選人、不需要密碼</b>，'
    +   '也不會再跳解鎖畫面。<br>適合：TMDB／OMDb 這種免費查詢金鑰。<br>'
    +   '不適合：GitHub token、密碼、任何有寫入權的東西（後台也會直接擋下來）。</p>'
    + (a.publicBlocked ? '<div class="warnbox">目前這個 App 勾了公開<b>但被擋下來</b>：'+esc(a.publicBlockReason||"")+'</div>' : '')
    + (on
        ? '<button class="btn-danger" onclick="savePublic(\''+id+'\', false, this)" style="margin-bottom:10px">關掉公開，改回要密碼</button>'
        : '<button class="btn-primary" onclick="savePublic(\''+id+'\', true, this)">我知道會被看到，設成公開</button>')
    + '<button class="btn-ghost" onclick="closeSheet()">算了</button>');
}
function savePublic(id, on, btn){
  busy(btn, on?"設定中…":"關閉中…");
  api("/apps/"+encodeURIComponent(id)+"/public","POST",{public:on})
    .then(function(d){ applyState(d); closeSheet();
      toast(on?"設成公開了，那個 App 打開網址就能用":"已經改回加密（要選人＋密碼）","ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent=on?"我知道會被看到，設成公開":"關掉公開，改回要密碼"; } });
}

/* ---------- 開場外觀（App 啟動時中央那一塊） ----------
 * 純顯示、公開明文，跟金鑰／加密完全無關（跟「公開模式」同一層級）。
 * 全部可留白：留白＝那一項由 App 自己決定，**不會被寫進 keyring.json**。 */
var SP_LABELS = { bg:"開場底色", accent:"符號底色", ink:"開場文字色" };

/* 列表上那一行摘要：他一眼要看得出這個 App 已經設過開場 */
function splashSummary(sp){
  var bits=[];
  if(sp.glyph) bits.push("符號 "+sp.glyph);
  if(sp.name) bits.push("名字 "+sp.name);
  if(sp.tagline) bits.push("「"+sp.tagline+"」");
  var cols=(sp.bg?1:0)+(sp.accent?1:0)+(sp.ink?1:0);
  if(cols) bits.push("自訂 "+cols+" 個顏色");
  return bits.join(" · ");
}

function openSplashForm(id){
  var a=appById(id), sp=a.splash||{};
  formState={ mode:"splash", id:id, appName:a.name,
    sp:{ name:sp.name||"", glyph:sp.glyph||"", bg:sp.bg||"", accent:sp.accent||"", ink:sp.ink||"", tagline:sp.tagline||"" } };
  drawSplashForm();
}
function splashColorRow(k){
  var v=formState.sp[k], d=KF.SPLASH_DEFAULTS[k];
  return '<div class="sp-crow'+(v?' on':'')+'" id="sp-row-'+k+'">'
    + '<input type="color" id="sp-'+k+'" value="'+esc(v||d)+'" oninput="splashColorIn(\''+k+'\',this.value)"'
    +   ' aria-label="'+esc(SP_LABELS[k])+'">'
    + '<div class="sp-cinfo"><b>'+esc(SP_LABELS[k])+'</b>'
    +   '<span id="sp-txt-'+k+'">'+(v?esc(v):'沿用 App 預設')+'</span></div>'
    + '<button type="button" class="sp-clr" id="sp-clr-'+k+'" onclick="splashColorClear(\''+k+'\')"'
    +   (v?'':' hidden')+'>改回預設</button>'
    + '</div>';
}
function drawSplashForm(){
  var f=formState.sp;
  openDialog('<div class="sheet-head"><h3>「'+esc(formState.appName)+'」的開場畫面</h3>'
    + '<button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="hint" style="margin-top:0">那個 App 一打開看到的第一頁。存檔＝發布，那個 App <b>下次啟動</b>就會變。<br>'
    +   '每一項都可以留白，留白的項目由 App 自己決定（<b>不會寫進公開檔</b>）。</div>'
    + '<div class="sp-wrap">'
    +   '<div class="sp-col"><div class="sp-prev" id="sp-prev"><div class="sp-mark" id="sp-mark"></div>'
    +     '<div class="sp-nm" id="sp-nm"></div><div class="sp-tg" id="sp-tg"></div></div>'
    +     '<div class="sp-tip">即時預覽<br>改右邊就會跟著變</div></div>'
    +   '<div class="sp-form">'
    +     '<label class="field"><span class="fl">開場顯示的名字</span>'
    +       '<input id="sp-name" maxlength="'+KF.SPLASH_MAX.name+'" value="'+esc(f.name)+'"'
    +       ' placeholder="留白＝用「'+esc(formState.appName)+'」" oninput="splashTextIn()"></label>'
    +     '<label class="field"><span class="fl">符號（只能一個字）</span>'
    +       '<input id="sp-glyph" value="'+esc(f.glyph)+'" placeholder="留白＝用名字的第一個字"'
    +       ' autocomplete="off" oninput="splashGlyphIn(event,this)" onblur="splashGlyphIn(null,this)"></label>'
    +     '<div class="hint">一個字或一個符號都可以（中文字、英文字母、emoji）。打第二個字不會吃進去。</div>'
    +     splashColorRow("bg")+splashColorRow("accent")+splashColorRow("ink")
    +     '<label class="field"><span class="fl">標語（選填）</span>'
    +       '<input id="sp-tag" maxlength="'+KF.SPLASH_MAX.tagline+'" value="'+esc(f.tagline)+'"'
    +       ' placeholder="例：紀律比行情重要" oninput="splashTextIn()"></label>'
    +   '</div>'
    + '</div>'
    + '<button class="btn-primary" onclick="saveSplash(this)">存起來</button>'
    + '<button class="btn-ghost" onclick="splashClearAll()">全部改回 App 預設</button>', "sp-name");
  splashPaint();
}
/* 打字時把值收進 formState 再重畫縮圖（不重畫整個對話框，游標才不會跳掉） */
function splashTextIn(){
  if($("sp-name")) formState.sp.name=$("sp-name").value;
  if($("sp-tag")) formState.sp.tagline=$("sp-tag").value;
  splashPaint();
}
/* 符號只能一個字：**在輸入框當場擋**（不是存檔才報錯）。
 * ⚠️ 中文注音／拼音輸入法組字中不能動 value，會把他打到一半的字打斷 → isComposing 時只畫預覽。 */
function splashGlyphIn(ev, el){
  var one=KF.normGlyph(el.value);
  if(!(ev && ev.isComposing) && el.value!==one) el.value=one;
  formState.sp.glyph=one;
  splashPaint();
}
function splashColorIn(k, v){
  formState.sp[k]=KF.normColor(v);
  var row=$("sp-row-"+k), txt=$("sp-txt-"+k), clr=$("sp-clr-"+k);
  if(row) row.className="sp-crow on";
  if(txt) txt.textContent=formState.sp[k]||"沿用 App 預設";
  if(clr) clr.hidden=false;
  splashPaint();
}
function splashColorClear(k){
  formState.sp[k]="";
  var row=$("sp-row-"+k), txt=$("sp-txt-"+k), clr=$("sp-clr-"+k), inp=$("sp-"+k);
  if(inp) inp.value=KF.SPLASH_DEFAULTS[k];
  if(row) row.className="sp-crow";
  if(txt) txt.textContent="沿用 App 預設";
  if(clr) clr.hidden=true;
  splashPaint();
}
function splashClearAll(){
  formState.sp={ name:"", glyph:"", bg:"", accent:"", ink:"", tagline:"" };
  drawSplashForm();
}
/* 縮圖：沒設定的項目用 KF.splashView 的預覽預設值畫出來（那些值不會被存進去） */
function splashPaint(){
  var v=KF.splashView({ name:formState.appName, splash:formState.sp });
  var prev=$("sp-prev"), mark=$("sp-mark"), nm=$("sp-nm"), tg=$("sp-tg");
  if(!prev) return;
  prev.style.background=v.bg;
  /* 連 color 一起設：「預覽」那個角標用 currentColor，底色一深它就看不見了 */
  prev.style.color=v.ink;
  /* 符號字色不是設定項：由 accent 自動推導（PM 拍板，跟 app-template 共用同一個函式） */
  mark.style.background=v.accent; mark.style.color=KF.onColor(v.accent); mark.textContent=v.glyph;
  nm.style.color=v.ink; nm.textContent=v.name;
  tg.style.color=v.ink; tg.textContent=v.tagline;
  tg.style.visibility=v.tagline?"visible":"hidden";
}
function saveSplash(btn){
  var sp=KF.normSplash(formState.sp);   /* 空的項目在這裡就被丟掉，不會送出去 */
  var why=KF.splashBlockReason(sp);
  if(why){ toast(why,"err"); return; }
  busy(btn);
  api("/apps/"+encodeURIComponent(formState.id)+"/splash","POST",{splash:sp})
    .then(function(d){ applyState(d); closeSheet();
      toast(sp?"存好了，那個 App 下次啟動就會變":"開場外觀改回 App 自己的預設了","ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="存起來"; } });
}

function openAppWho(id){
  var a=appById(id);
  formState={id:id, userIds:S.users.filter(function(u){return u.apps.indexOf(id)>=0;}).map(function(u){return u.id;})};
  var list=S.users.length ? S.users.map(function(u){
    var on=formState.userIds.indexOf(u.id)>=0;
    return '<label class="appcheck"><input type="checkbox" '+(on?"checked":"")
      + ' onchange="toggleWho(\''+u.id+'\',this.checked)">'
      + '<span class="em">'+u.emoji+'</span><span class="nm">'+esc(u.name)+'</span>'
      + '<span class="ck-box"></span></label>';
  }).join("") : '<div class="hint" style="margin:0">還沒有任何使用者。</div>';
  openDialog('<div class="sheet-head"><h3>誰可以用「'+esc(a.name)+'」</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="applist">'+list+'</div>'
    + '<div class="hint" style="margin-top:12px">沒勾的人，解鎖後也拿不到這個 App 的鑰匙。</div>'
    + '<button class="btn-primary" onclick="saveWho(this)">好了</button>');
}
function toggleWho(uid, on){
  var i=formState.userIds.indexOf(uid);
  if(on && i<0) formState.userIds.push(uid);
  if(!on && i>=0) formState.userIds.splice(i,1);
}
function saveWho(btn){
  busy(btn);
  api("/apps/"+encodeURIComponent(formState.id)+"/users","POST",{userIds:formState.userIds})
    .then(function(d){ applyState(d); closeSheet(); toast("存好了","ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="好了"; } });
}
function askDeleteApp(id){
  var a=appById(id);
  openDialog('<div class="sheet-head"><h3>要刪掉 '+esc(a.name)+' 嗎？</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="warnbox">刪掉之後，所有人都拿不到這個 App 的鑰匙了。</div>'
    + '<button class="btn-danger" onclick="doDeleteApp(\''+id+'\', this)" style="margin-bottom:10px">刪掉</button>'
    + '<button class="btn-ghost" onclick="closeSheet()">算了</button>');
}
function doDeleteApp(id, btn){
  busy(btn, "刪除中…");
  api("/apps/"+encodeURIComponent(id),"DELETE")
    .then(function(d){ applyState(d); closeSheet(); toast("刪掉了"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="刪掉"; } });
}

/* Esc 關閉 */
document.addEventListener("keydown", function(e){
  if(e.key==="Escape" && !$("sheet-layer").hidden) closeSheet();
});

/* 開機 */
api("/state").then(applyState).catch(function(e){
  $("admin").innerHTML='<div class="empty"><div class="big">🌧️</div><p>'+esc(e.message)+'</p></div>';
});
