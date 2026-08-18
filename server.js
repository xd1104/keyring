'use strict';

/*
 * 鑰匙圈（keyring）— 本機後台小工具（零執行期依賴，只用 node 內建）
 *
 * 它在做什麼：
 *   GitHub Pages 是純靜態、沒有伺服器可以驗密碼。所以把每個 App 的 GitHub PAT
 *   用「每個人的密碼」各加密一份，密文放公開的鑰匙圈 repo，手機前端用 WebCrypto 解開。
 *   密碼錯 = AES-GCM 驗證失敗，不需要另外存 hash。
 *
 * 兩個檔案（刻意分開）：
 *   secrets.json  本機專用。明文 PAT ＋ 每個人的派生金鑰。**在 .gitignore 裡，永不上傳**。
 *   keyring.json  公開產物。只有密文、salt、iv，沒有任何明文 PAT／密碼／密碼 hash。
 *
 * 存檔即發布（Benson 拍板）：任何修改都會重產 keyring.json 並自動 git commit + push，
 * 不做「未發布變更」的草稿狀態。發布失敗（例如 repo 還沒開）不影響本機存檔，只回報狀態。
 *
 * 架構比照 travel-planner/server.js；本工具 port 4620。
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SECRETS_FILE = path.join(ROOT, 'secrets.json');
const KEYRING_FILE = path.join(ROOT, 'keyring.json');

const PORT = process.env.PORT || 4620;

/* 加密參數（與前端 keyring-unlock.js 是同一套，改要兩邊一起改） */
const KDF = { algo: 'PBKDF2-SHA256', iter: 600000, hash: 'sha256', keyLen: 32 };

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// 原子寫入：先寫暫存檔再 rename，中途斷電不會留半份壞檔
async function writeFileAtomic(file, text) {
  const tmp = file + '.tmp~' + process.pid;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

/* id 鐵律（travel-book 的血淚教訓）：**一律 ASCII**，顯示用的原文留在 name。
 * 中文／日韓文 id 會在不同系統之間被正規化成不同字串（NFC vs NFD）而分裂成兩筆。
 * 先做 NFC 正規化再過濾，避免 macOS/iOS 打出來的 NFD 組合字被削掉一半。 */
function slugify(s) {
  const t = String(s || '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, '-');
  let out = '';
  for (const ch of t) out += /[a-z0-9._-]/.test(ch) ? ch : '';
  return out.replace(/^[-.]+|[-.]+$/g, '');
}
function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
}
function uniqueId(base, taken) {
  let id = base, n = 2;
  while (taken.indexOf(id) >= 0) id = base + '-' + n++;
  return id;
}

/* 遮罩：github_pat_11AB••••••••3f（前 14 後 4，短的就整條遮掉） */
function maskToken(t) {
  const s = String(t || '');
  if (!s) return '';
  if (s.length <= 18) return s.slice(0, 3) + '••••••••';
  return s.slice(0, 14) + '••••••••' + s.slice(-4);
}

/* ------------------------------------------------------------------ */
/* 加解密（Node crypto；前端用 WebCrypto，格式必須一致）                 */
/*   PBKDF2-SHA256 600000 次 -> 32 bytes 金鑰                           */
/*   AES-GCM 256，cipher = 密文 || 16 bytes authTag（WebCrypto 的格式）  */
/* ------------------------------------------------------------------ */
function deriveKey(password, saltB64) {
  return crypto.pbkdf2Sync(
    Buffer.from(String(password), 'utf8'),
    Buffer.from(saltB64, 'base64'),
    KDF.iter, KDF.keyLen, KDF.hash);
}
function encryptWithKey(keyBuf, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const ct = Buffer.concat([c.update(Buffer.from(String(plaintext), 'utf8')), c.final()]);
  return { iv: iv.toString('base64'), cipher: Buffer.concat([ct, c.getAuthTag()]).toString('base64') };
}

/* ------------------------------------------------------------------ */
/* secrets.json（本機唯一真本）                                         */
/* ------------------------------------------------------------------ */
/*  {
 *    version, updatedAt,
 *    apps:  [{id,name,emoji,url,token}]                 <- token 是明文，只在這台電腦
 *    users: [{id,name,emoji,theme,salt,dk,apps:[appId]}] <- dk = 派生金鑰(base64)，不存密碼
 *  }
 *  刻意存「派生金鑰」而不是密碼：後台真的看不到任何人的密碼（符合設計規格 1-3），
 *  但又能在「加一個 App 給某人」時直接用他的金鑰加密新條目，不必再問他一次密碼。
 */
let S = { version: 1, updatedAt: null, apps: [], users: [] };

function loadSecrets() {
  try {
    const raw = fs.readFileSync(SECRETS_FILE, 'utf8');
    const d = JSON.parse(raw);
    S = {
      version: 1,
      updatedAt: d.updatedAt || null,
      apps: Array.isArray(d.apps) ? d.apps : [],
      users: Array.isArray(d.users) ? d.users : [],
    };
    S.users.forEach((u) => { if (!Array.isArray(u.apps)) u.apps = []; });
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[secrets] 讀取失敗，改用空的鑰匙圈：', e.message);
    S = { version: 1, updatedAt: null, apps: [], users: [] };
  }
}
async function saveSecrets() {
  S.updatedAt = new Date().toISOString();
  await writeFileAtomic(SECRETS_FILE, JSON.stringify(S, null, 2) + '\n');
}

/* 產出公開的 keyring.json：只有密文 */
function buildKeyring() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    apps: S.apps.map((a) => ({ id: a.id, name: a.name, emoji: a.emoji })),
    users: S.users.map((u) => {
      const apps = {};
      (u.apps || []).forEach((appId) => {
        const app = S.apps.find((a) => a.id === appId);
        if (!app || !app.token || !u.dk) return;
        const key = Buffer.from(u.dk, 'base64');
        const e = encryptWithKey(key, app.token);
        apps[appId] = { iv: e.iv, cipher: e.cipher };
      });
      return {
        id: u.id, name: u.name, emoji: u.emoji, theme: u.theme,
        kdf: { algo: KDF.algo, iter: KDF.iter, salt: u.salt },
        apps,
      };
    }),
  };
}

/* 上一次發布的結果（給前端顯示狀態列用）
 * code   ＝ 出了什麼事（前端據此決定要不要給「幫我接起來」那顆按鈕）
 * how    ＝ 下一步該做什麼（人話，逐條）
 * 不管哪一種失敗，本機都一定已經存好了 —— 這件事一定要講給使用者聽。 */
let pubState = { ok: true, at: null, code: 'idle', message: '還沒有需要發布的東西', how: [], canSetup: false };

/* GitHub 上鑰匙圈 repo 的位置（第一次接線用） */
const REPO_OWNER = 'xd1104';
const REPO_NAME = 'keyring';
const REPO_URL = 'https://github.com/' + REPO_OWNER + '/' + REPO_NAME + '.git';

/* ------------------------------------------------------------------ */
/* 發布（git add/commit/pull/push 到 keyring repo）                      */
/* ------------------------------------------------------------------ */
function gitCmd(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 25000,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }), // 別跳帳密視窗卡住
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(((stderr || stdout || err.message) + '').trim().slice(0, 400)));
      else resolve((stdout || '') + '');
    });
  });
}

/* 安全閘門：secrets.json 一定要被 git 忽略，否則什麼都不做。
 * 用「白名單語意」寫：確認它真的被忽略才放行，而不是列舉禁止的檔名。 */
async function assertSecretsSafe() {
  await gitCmd(['check-ignore', '-q', 'secrets.json']).catch(() => {
    throw new Error('secrets.json 沒有被 .gitignore 忽略，為了安全已中止發布');
  });
  const status = await gitCmd(['status', '--porcelain']);
  if (/secrets\.json/.test(status)) throw new Error('git 看得到 secrets.json，為了安全已中止發布');
}

/* git 的英文錯誤 -> 人話 ＋ 下一步。使用者不該看到 "fatal: not a git repository"。 */
function fail(code, message, how, canSetup) {
  pubState = {
    ok: false, at: new Date().toISOString(), code, message,
    how: how || [], canSetup: !!canSetup,
  };
  return pubState;
}
function classifyGitError(raw) {
  const s = String(raw || '');
  if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied|403/i.test(s)) {
    return fail('auth', 'GitHub 不讓這台電腦寫入（登入資訊過期或沒權限）。東西已經存在這台電腦上了，不會不見。', [
      '在一般的命令提示字元跑一次：git push origin HEAD，照它的指示登入一次',
      '或用 GitHub Desktop 登入同一個帳號（xd1104）',
      '登入好之後回來按「再試一次」',
    ]);
  }
  if (/Repository not found|remote: Not Found|does not appear to be a git repository/i.test(s)) {
    return fail('no_github_repo', '找不到 GitHub 上的 ' + REPO_OWNER + '/' + REPO_NAME + ' 這個 repo。東西已經存在這台電腦上了，不會不見。', [
      '到 github.com 開一個新的 repo，名字叫 ' + REPO_NAME + '（Public）',
      '不用加 README、不用加 .gitignore（這邊已經有了）',
      '開好之後回來按「再試一次」',
    ]);
  }
  if (/Could not resolve host|unable to access|Connection|timed out|Operation too slow/i.test(s)) {
    return fail('net', '現在連不到 GitHub（網路問題）。東西已經存在這台電腦上了，不會不見。', [
      '等網路恢復之後按「再試一次」',
    ]);
  }
  if (/rejected|non-fast-forward|failed to push/i.test(s)) {
    return fail('conflict', 'GitHub 上有這台電腦還沒有的改動，先合併才能送出去。東西已經存在這台電腦上了，不會不見。', [
      '按「再試一次」（會先拉一次再送）',
      '還是不行的話跟我說一聲，我幫你看',
    ]);
  }
  return fail('other', '發布沒成功。東西已經存在這台電腦上了，不會不見。', [
    '按「再試一次」看看',
    '一直不行的話，把這行貼給我：' + firstLine(s),
  ]);
}

let publishing = false;
async function publish() {
  if (publishing) return pubState;
  publishing = true;
  try {
    /* ① 這個資料夾還沒變成 git repo（第一次使用一定是這個狀態） */
    try {
      await gitCmd(['rev-parse', '--is-inside-work-tree']);
    } catch (e) {
      return fail('no_repo',
        '這台電腦的鑰匙圈資料夾還沒跟 GitHub 接上，所以只存在本機。東西已經存好了，不會不見。',
        ['先在 github.com 開一個 Public 的 repo，名字叫 ' + REPO_NAME,
         '再按下面那顆「幫我接起來」，我會把這個資料夾接上 ' + REPO_OWNER + '/' + REPO_NAME,
         '接好之後會自動送出去，之後每次存檔都會自動發布'],
        true);
    }

    /* ② 安全閘門：secrets.json 一定要被忽略 */
    try {
      await assertSecretsSafe();
    } catch (e) {
      return fail('unsafe',
        '為了安全，這次沒有發布：明文金鑰的檔案（secrets.json）沒有被 .gitignore 擋住，不能讓它上傳。',
        ['檢查 keyring 資料夾裡的 .gitignore 有沒有 secrets.json 這一行', '修好之後按「再試一次」']);
    }

    await gitCmd(['add', '-A']);
    const status = await gitCmd(['status', '--porcelain']);
    if (status.trim()) {
      await gitCmd(['commit', '-m', 'keyring: update ' + new Date().toISOString()]);
    }

    /* ③ 還沒指到 GitHub 上的 repo */
    try {
      await gitCmd(['remote', 'get-url', 'origin']);
    } catch (e) {
      return fail('no_remote',
        '這個資料夾還沒指到 GitHub 上的 ' + REPO_OWNER + '/' + REPO_NAME + '。東西已經存在這台電腦上了，不會不見。',
        ['GitHub 上的 repo 開好之後，按下面那顆「幫我接起來」', '我會把它接上 ' + REPO_URL],
        true);
    }

    let branch = 'main';
    try { branch = (await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main'; } catch { /* 還沒有任何 commit */ }
    try { await gitCmd(['pull', '--no-edit', '--no-rebase', '-X', 'ours', 'origin', branch]); } catch (e) {
      console.log('[publish] pull 略過：' + firstLine(e.message));
    }
    await gitCmd(['push', 'origin', 'HEAD']);
    pubState = { ok: true, at: new Date().toISOString(), code: 'ok', message: '已經發布到 GitHub', how: [], canSetup: false };
  } catch (e) {
    /* 發布失敗絕不影響本機存檔（上面早就寫進硬碟了），只翻譯成人話記下來 */
    classifyGitError(e && e.message);
    console.error('[publish] 失敗：' + firstLine(e && e.message));
  } finally {
    publishing = false;
  }
  return pubState;
}
function firstLine(s) { return String(s || '').split('\n')[0].slice(0, 200); }

/* 開機先體檢一次（不 commit、不 push）：
 * 第一次用的時候，Benson 打開後台看到的第一個畫面就該告訴他「還沒接上 GitHub、下一步做什麼」，
 * 而不是等他存了一筆才發現。 */
async function diagnose() {
  try {
    await gitCmd(['rev-parse', '--is-inside-work-tree']);
  } catch (e) {
    return fail('no_repo',
      '這台電腦的鑰匙圈資料夾還沒跟 GitHub 接上，所以現在只存在本機。你存的東西不會不見，只是別的裝置還拿不到。',
      ['先在 github.com 開一個 Public 的 repo，名字叫 ' + REPO_NAME,
       '再按下面那顆「幫我接起來」，我會把這個資料夾接上 ' + REPO_OWNER + '/' + REPO_NAME,
       '接好之後會自動送出去，之後每次存檔都會自動發布'],
      true);
  }
  try {
    await gitCmd(['remote', 'get-url', 'origin']);
  } catch (e) {
    return fail('no_remote',
      '這個資料夾還沒指到 GitHub 上的 ' + REPO_OWNER + '/' + REPO_NAME + '，所以現在只存在本機。你存的東西不會不見。',
      ['GitHub 上的 repo 開好之後，按下面那顆「幫我接起來」', '我會把它接上 ' + REPO_URL],
      true);
  }
  return pubState;
}

/* 「幫我接起來」：只做本機接線（git init ＋ 認 main ＋ 加 origin），做完再試一次發布。
 * 刻意不幫他在 GitHub 上開 repo（那要金鑰，也該由他自己決定 Public/Private）。 */
async function setupRepo() {
  let inRepo = true;
  try { await gitCmd(['rev-parse', '--is-inside-work-tree']); } catch { inRepo = false; }
  if (!inRepo) {
    await gitCmd(['init']);
    try { await gitCmd(['symbolic-ref', 'HEAD', 'refs/heads/main']); } catch { /* 舊版 git 沒差 */ }
  }
  let hasRemote = true;
  try { await gitCmd(['remote', 'get-url', 'origin']); } catch { hasRemote = false; }
  if (!hasRemote) await gitCmd(['remote', 'add', 'origin', REPO_URL]);
  return publish();
}

/* 每次異動：重產 keyring.json -> 存 secrets.json -> 自動發布 */
async function commitChanges() {
  await saveSecrets();
  await writeFileAtomic(KEYRING_FILE, JSON.stringify(buildKeyring(), null, 2) + '\n');
  return publish();
}

/* ------------------------------------------------------------------ */
/* 給前端的視圖（明文 token 永遠不出這台機器、也不回傳給瀏覽器）           */
/* ------------------------------------------------------------------ */
function viewState() {
  return {
    apps: S.apps.map((a) => ({
      id: a.id, name: a.name, emoji: a.emoji, url: a.url || '',
      masked: maskToken(a.token), hasToken: !!a.token,
      users: S.users.filter((u) => (u.apps || []).indexOf(a.id) >= 0).map((u) => u.id),
    })),
    users: S.users.map((u) => ({
      id: u.id, name: u.name, emoji: u.emoji, theme: u.theme, apps: (u.apps || []).slice(),
    })),
    publish: pubState,
    updatedAt: S.updatedAt,
  };
}

function findUser(id) { return S.users.find((u) => u.id === id) || null; }
function findApp(id) { return S.apps.find((a) => a.id === id) || null; }

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const m = req.method;

  if (p === '/state' && m === 'GET') return sendJson(res, 200, { ok: true, state: viewState() });

  /* 這兩支「請求本身」一定算成功（HTTP 200 + ok:true）；
   * 發布結果看 state.publish，才不會讓前端把「發布沒成功」講成「失敗（200）」 */
  if (p === '/publish' && m === 'POST') {
    await commitChanges();
    return sendJson(res, 200, { ok: true, state: viewState() });
  }
  if (p === '/setup' && m === 'POST') {
    try {
      await setupRepo();
    } catch (e) {
      classifyGitError(e && e.message);
    }
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  /* ---- 使用者 ---- */
  if (p === '/users' && m === 'POST') {
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (!name) return sendJson(res, 400, { ok: false, message: '先幫他取個名字' });
    const apps = Array.isArray(b.apps) ? b.apps.filter((x) => !!findApp(x)) : [];
    let u = b.id ? findUser(b.id) : null;
    if (u) {
      u.name = name; u.emoji = b.emoji || u.emoji; u.theme = b.theme || u.theme; u.apps = apps;
    } else {
      const pw = String(b.password || '');
      if (!pw) return sendJson(res, 400, { ok: false, message: '先設一組密碼給他' });
      /* 使用者 id 純粹是內部識別，直接給 ASCII 流水號；名字（可能是中文）留在 name */
      const id = uniqueId(newId('u'), S.users.map((x) => x.id));
      const salt = crypto.randomBytes(16).toString('base64');
      u = {
        id, name, emoji: b.emoji || '🧑', theme: b.theme || 'night',
        salt, dk: deriveKey(pw, salt).toString('base64'), apps,
      };
      S.users.push(u);
    }
    await commitChanges();
    return sendJson(res, 200, { ok: true, userId: u.id, state: viewState() });
  }

  let mt = p.match(/^\/users\/([^/]+)\/password$/);
  if (mt && m === 'POST') {
    const u = findUser(decodeURIComponent(mt[1]));
    if (!u) return sendJson(res, 404, { ok: false, message: '找不到這個人' });
    const b = await readJson(req);
    const pw = String(b.password || '');
    if (!pw) return sendJson(res, 400, { ok: false, message: '先輸入新密碼' });
    // 換密碼＝順便換 salt，再用新金鑰把他所有 App 的 PAT 重加密（buildKeyring 會做）
    u.salt = crypto.randomBytes(16).toString('base64');
    u.dk = deriveKey(pw, u.salt).toString('base64');
    await commitChanges();
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  mt = p.match(/^\/users\/([^/]+)$/);
  if (mt && m === 'DELETE') {
    const id = decodeURIComponent(mt[1]);
    S.users = S.users.filter((u) => u.id !== id);
    await commitChanges();
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  /* ---- App 金鑰 ---- */
  if (p === '/apps' && m === 'POST') {
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (!name) return sendJson(res, 400, { ok: false, message: '先給它一個名字' });
    let a = b.id ? findApp(b.id) : null;
    if (a) {
      a.name = name; a.emoji = b.emoji || a.emoji; a.url = String(b.url || a.url || '');
      if (b.token) a.token = String(b.token).trim();
    } else {
      const token = String(b.token || '').trim();
      if (!token) return sendJson(res, 400, { ok: false, message: '要貼上金鑰才有東西可以發' });
      /* App id 是 Benson 自己填的代號（要跟該 App 前端的 appId 一致），一樣只收 ASCII */
      const id = uniqueId(slugify(b.appId || name) || newId('app'), S.apps.map((x) => x.id));
      a = { id, name, emoji: b.emoji || '📦', url: String(b.url || ''), token };
      S.apps.push(a);
    }
    await commitChanges();
    return sendJson(res, 200, { ok: true, appId: a.id, state: viewState() });
  }

  mt = p.match(/^\/apps\/([^/]+)\/token$/);
  if (mt && m === 'POST') {
    const a = findApp(decodeURIComponent(mt[1]));
    if (!a) return sendJson(res, 404, { ok: false, message: '找不到這個 App' });
    const b = await readJson(req);
    const token = String(b.token || '').trim();
    if (!token) return sendJson(res, 400, { ok: false, message: '先貼上新的金鑰' });
    a.token = token;
    await commitChanges();
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  mt = p.match(/^\/apps\/([^/]+)\/users$/);
  if (mt && m === 'POST') {
    const appId = decodeURIComponent(mt[1]);
    if (!findApp(appId)) return sendJson(res, 404, { ok: false, message: '找不到這個 App' });
    const b = await readJson(req);
    const ids = Array.isArray(b.userIds) ? b.userIds : [];
    S.users.forEach((u) => {
      const has = (u.apps || []).indexOf(appId) >= 0;
      const want = ids.indexOf(u.id) >= 0;
      if (want && !has) u.apps.push(appId);
      if (!want && has) u.apps = u.apps.filter((x) => x !== appId);
    });
    await commitChanges();
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  mt = p.match(/^\/apps\/([^/]+)$/);
  if (mt && m === 'DELETE') {
    const id = decodeURIComponent(mt[1]);
    S.apps = S.apps.filter((a) => a.id !== id);
    S.users.forEach((u) => { u.apps = (u.apps || []).filter((x) => x !== id); });
    await commitChanges();
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  return sendJson(res, 404, { ok: false, message: '沒有這個 API' });
}

/* ------------------------------------------------------------------ */
/* 靜態檔                                                              */
/* ------------------------------------------------------------------ */
function streamFile(res, file, extraHeaders) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, Object.assign({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }, extraHeaders || {}));
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 本機預覽用：讓別的 App（例如 localhost 的旅途手帳）可以抓這份鑰匙圈來測
  if (rel === '/keyring.json') {
    return streamFile(res, KEYRING_FILE, { 'Access-Control-Allow-Origin': '*' });
  }
  // 前端解鎖模組的正本放這裡，各 App 複製過去用
  if (rel === '/keyring-unlock.js') {
    return streamFile(res, path.join(ROOT, 'client', 'keyring-unlock.js'), { 'Access-Control-Allow-Origin': '*' });
  }

  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { // 防路徑穿越
    res.writeHead(400); return res.end('bad path');
  }
  streamFile(res, file);
}

/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, message: '伺服器錯誤：' + msg });
    else res.end();
  }
});

loadSecrets();
server.listen(PORT, async () => {
  console.log('Keyring admin running at http://localhost:' + PORT);
  console.log('Secrets (local only): ' + SECRETS_FILE);
  console.log('Public keyring:       ' + KEYRING_FILE);
  await diagnose();          // 第一個畫面就要說實話
  if (!pubState.ok) console.log('[publish] ' + pubState.message);
});
