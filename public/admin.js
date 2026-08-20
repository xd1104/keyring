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

var S = { apps:[], users:[], publish:{ok:true, message:"", at:null} };
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
    + '<div class="ad-tabs">'
    +   '<button class="'+(adTab==="users"?"on":"")+'" onclick="setTab(\'users\')">👥 使用者</button>'
    +   '<button class="'+(adTab==="apps"?"on":"")+'" onclick="setTab(\'apps\')">📦 App 金鑰</button>'
    + '</div>'
    + (adTab==="users" ? adUsers() : adApps())
    + '<div class="ad-foot">密碼是各自加密的，這裡看不到、也救不回來。<br>'
    +   '有人忘記密碼，就在這裡幫他換一組新的。金鑰的明文只留在這台電腦。</div>';
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
      +   '<div class="chips">'+chips+'</div></div>'
      + '<div class="rc-acts">'
      +   '<button onclick="openKeyForm(\''+a.id+'\')">換金鑰</button>'
      +   '<button onclick="openAppWho(\''+a.id+'\')">誰可以用</button>'
      +   '<button class="danger" onclick="askDeleteApp(\''+a.id+'\')">刪除</button>'
      + '</div></div>';
  }).join("");
  return '<div class="sec-title">App（'+S.apps.length+'）</div>'+rows
    + '<button class="addcard" onclick="openAppForm()">＋ 登記新的 App</button>';
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
function openAppForm(){ formState={emoji:"📦"}; drawAppForm(); }
function drawAppForm(){
  var picks = APP_EMOJIS.map(function(e){
    return '<label class="pick"><input type="radio" name="afe" '+(formState.emoji===e?"checked":"")
      + ' onchange="formState.emoji=\''+e+'\'"><span>'+e+'</span></label>';
  }).join("");
  openDialog('<div class="sheet-head"><h3>登記新的 App</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<label class="field"><span class="fl">App 名稱</span><input id="af-name" placeholder="例：旅途手帳"></label>'
    + '<label class="field"><span class="fl">代號（App 程式裡用的 id）</span>'
    +   '<input id="af-id" placeholder="例：travel-book" autocapitalize="off" spellcheck="false"></label>'
    + '<div class="hint">要跟那個 App 前端設定的 appId 一模一樣，留空就用名字自動產生。</div>'
    + '<div class="field"><span class="fl">圖示</span><div class="pickrow">'+picks+'</div></div>'
    + '<label class="field"><span class="fl">網址</span>'
    +   '<input id="af-url" placeholder="https://…" inputmode="url" autocapitalize="off" spellcheck="false"></label>'
    + '<label class="field"><span class="fl">GitHub 金鑰（選填）</span>'
    +   '<input id="af-key" type="password" placeholder="留空就沿用現在這把" autocomplete="off" spellcheck="false"></label>'
    + '<div class="hint">'+(S.apps.length
        ? '留空就沿用現在這把（你的 App 都共用同一把）。要給這個 App 另一把才貼。'
        : '這是第一個 App，先貼一把進來。之後再加 App 就會自動沿用這把。')
      + '明文只留在這台電腦。</div>'
    + '<button class="btn-primary" onclick="saveApp(this)">登記</button>', "af-name");
}
function saveApp(btn){
  var n=($("af-name").value||"").trim(), id=($("af-id").value||"").trim();
  var u=($("af-url").value||"").trim(), k=($("af-key").value||"").trim();
  if(!n){ toast("先給它一個名字", "err"); return; }
  /* 金鑰留空＝沿用現在這把；一把都還沒有時由 server 回人話擋下來 */
  busy(btn, "登記中…");
  api("/apps","POST",{name:n, appId:id, emoji:formState.emoji, url:u, token:k})
    .then(function(d){ applyState(d); closeSheet(); toast("登記好了，現有的人都已經可以用了","ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="登記"; } });
}
function openKeyForm(id){
  var a=appById(id);
  openDialog('<div class="sheet-head"><h3>換「'+esc(a.name)+'」的金鑰</h3><button onclick="closeSheet()" aria-label="關閉">✕</button></div>'
    + '<div class="hint" style="margin-top:0">目前：<span class="keyline">'+esc(a.masked||"（還沒有金鑰）")+'</span></div>'
    + '<label class="field"><span class="fl">新的金鑰</span>'
    +   '<input id="kf-key" type="password" placeholder="github_pat_…" autocomplete="off" spellcheck="false"></label>'
    + '<div class="warnbox">換金鑰不用改任何人的密碼，發布之後大家自動換到新的。</div>'
    + '<button class="btn-primary" onclick="saveKey(\''+id+'\', this)">換上去</button>', "kf-key");
}
function saveKey(id, btn){
  var k=($("kf-key").value||"").trim();
  if(!k){ toast("先貼上新的金鑰", "err"); return; }
  busy(btn, "換金鑰中…");
  api("/apps/"+encodeURIComponent(id)+"/token","POST",{token:k})
    .then(function(d){ applyState(d); closeSheet(); toast("換好了","ok"); })
    .catch(function(e){ toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="換上去"; } });
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
