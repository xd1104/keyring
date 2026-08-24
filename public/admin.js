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
          sync:{ok:true, message:"", adopted:false}, vault:{enabled:false} };
var adTab = "users";
var formState = {};

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
    + '<div class="ad-tabs">'
    +   '<button class="'+(adTab==="users"?"on":"")+'" onclick="setTab(\'users\')">👥 使用者</button>'
    +   '<button class="'+(adTab==="apps"?"on":"")+'" onclick="setTab(\'apps\')">📦 App 金鑰</button>'
    +   '<button class="'+(adTab==="vault"?"on":"")+'" onclick="setTab(\'vault\')">📱 手機後台</button>'
    + '</div>'
    + (adTab==="users" ? adUsers() : adTab==="apps" ? adApps() : adVault())
    /* 手機後台那頁有自己的說明，不要再疊一段講使用者密碼的 */
    + (adTab==="vault" ? '' :
        '<div class="ad-foot">密碼是各自加密的，這裡看不到、也救不回來。<br>'
      + '有人忘記密碼，就在這裡幫他換一組新的。金鑰的明文只留在這台電腦。</div>');
}
function setTab(t){ adTab=t; render(); }

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
    return '<div class="rowcard">'
      + '<div class="rc-face" style="background:'+grad("sand")+'">'+a.emoji+'</div>'
      + '<div class="rc-bd"><b>'+esc(a.name)+'</b>'
      +   '<div class="keyline">'+esc(a.masked||"（還沒有金鑰）")+'</div>'
      +   ((a.fields||[]).length && a.fieldsOk===false
            ? '<div class="keyline" style="color:#8a5b12">⚠ 這個 App 分了 '+a.fields.length+' 格，但存的東西還是舊格式 —— 按「換金鑰」確認一次</div>' : '')
      +   '<div class="chips">'+chips+'</div></div>'
      + '<div class="rc-acts">'
      +   '<button onclick="openKeyForm(\''+a.id+'\')">換金鑰</button>'
      +   '<button onclick="openFieldsForm(\''+a.id+'\')">金鑰欄位</button>'
      +   '<button onclick="openAppWho(\''+a.id+'\')">誰可以用</button>'
      +   '<button class="danger" onclick="askDeleteApp(\''+a.id+'\')">刪除</button>'
      + '</div></div>';
  }).join("");
  return '<div class="sec-title">App（'+S.apps.length+'）</div>'+rows
    + '<button class="addcard" onclick="openAppForm()">＋ 登記新的 App</button>';
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
      +   '<input class="fr-label" placeholder="標題（TMDB 金鑰）" value="'+esc(f.label)+'"'
      +     ' oninput="fieldSet('+i+',\'label\',this.value)">'
      +   '<button type="button" class="fr-del" onclick="fieldDel('+i+')" aria-label="刪掉這一格">✕</button>'
      + '</div>'
      + '<div class="fr-line">'
      +   '<input class="fr-hint" placeholder="說明（選填，會顯示在輸入框下面）" value="'+esc(f.hint)+'"'
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
    + '需要兩把金鑰的 App（例如好雷嗎的 TMDB＋OMDb）就加兩格，後台會幫你組成 App 讀得懂的格式。</div>'
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
function openAppForm(){ formState={mode:"app", emoji:"📦", fields:[], name:"", appId:"", url:"", token:""}; drawAppForm(); }
function drawAppForm(){
  var picks = APP_EMOJIS.map(function(e){
    return '<label class="pick"><input type="radio" name="afe" '+(formState.emoji===e?"checked":"")
      + ' onchange="formState.emoji=\''+e+'\'"><span>'+e+'</span></label>';
  }).join("");
  openDialog('<div class="sheet-head"><h3>登記新的 App</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<label class="field"><span class="fl">App 名稱</span><input id="af-name" placeholder="例：旅途手帳" value="'+esc(formState.name||"")+'"></label>'
    + '<label class="field"><span class="fl">代號（App 程式裡用的 id）</span>'
    +   '<input id="af-id" placeholder="例：travel-book" autocapitalize="off" spellcheck="false" value="'+esc(formState.appId||"")+'"'
    +   ' oninput="formState.appId=this.value" onchange="formRedraw()"></label>'
    + '<div class="hint">要跟那個 App 前端設定的 appId 一模一樣，留空就用名字自動產生。</div>'
    + '<div class="field"><span class="fl">圖示</span><div class="pickrow">'+picks+'</div></div>'
    + '<label class="field"><span class="fl">網址</span>'
    +   '<input id="af-url" placeholder="https://…" inputmode="url" autocapitalize="off" spellcheck="false" value="'+esc(formState.url||"")+'"></label>'
    + fieldsEditorHtml()
    + ((formState.fields||[]).length
        ? '<div class="hint">登記好之後在那一列按「換金鑰」就會看到 '+(formState.fields.length)+' 格，一格一把貼進去。</div>'
        : '<label class="field"><span class="fl">GitHub 金鑰（選填）</span>'
          + '<input id="af-key" type="password" placeholder="留空就沿用現在這把" autocomplete="off" spellcheck="false" value="'+esc(formState.token||"")+'"></label>'
          + '<div class="hint">'+(S.apps.length
              ? '留空就沿用現在這把（你的 App 都共用同一把）。要給這個 App 另一把才貼。'
              : '這是第一個 App，先貼一把進來。之後再加 App 就會自動沿用這把。')
            + '明文只留在這台電腦。</div>')
    + '<button class="btn-primary" onclick="saveApp(this)">登記</button>', "af-name");
}
function saveApp(btn){
  var n=($("af-name").value||"").trim(), id=($("af-id").value||"").trim();
  var u=($("af-url").value||"").trim(), k=($("af-key") ? ($("af-key").value||"").trim() : "");
  if(!n){ toast("先給它一個名字", "err"); return; }
  var fields = KF.normFields(formState.fields||[]);
  if((formState.fields||[]).length && !fields.length){
    toast("那幾格的代號還沒填（只能用英文小寫，例如 tmdb）", "err"); return;
  }
  /* 金鑰留空＝沿用現在這把；一把都還沒有時由 server 回人話擋下來 */
  busy(btn, "登記中…");
  api("/apps","POST",{name:n, appId:id, emoji:formState.emoji, url:u, token:k, fields:fields})
    .then(function(d){ applyState(d); closeSheet(); toast("登記好了，現有的人都已經可以用了","ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="登記"; } });
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
      + '<span class="hint">'+now+(f.hint?'　'+esc(f.hint):'')+'</span>'
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
