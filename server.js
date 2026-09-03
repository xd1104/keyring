'use strict';

/*
 * 鑰匙圈（keyring）— 本機後台小工具（零執行期依賴，只用 node 內建）
 *
 * 它在做什麼：
 *   GitHub Pages 是純靜態、沒有伺服器可以驗密碼。所以把每個 App 的 GitHub PAT
 *   用「每個人的密碼」各加密一份，密文放公開的鑰匙圈 repo，手機前端用 WebCrypto 解開。
 *   密碼錯 = AES-GCM 驗證失敗，不需要另外存 hash。
 *
 * 四個檔案（刻意分開）：
 *   secrets.json  本機專用。明文 PAT ＋ 每個人的派生金鑰。**在 .gitignore 裡，永不上傳**。
 *   keyring.json  公開產物。只有密文、salt、iv，沒有任何明文 PAT／密碼／密碼 hash。
 *   vault.json    公開產物，但整份是密文：secrets.json 用「管理密碼＋裝置配對碼」加密後的樣子。
 *                 手機後台（web/，純靜態）就是靠它在瀏覽器裡把真本解開來改。
 *   vault.key     本機專用。解 vault.json 的金鑰與這台電腦的配對碼。**一樣永不上傳**。
 *
 * 存檔即發布（Benson 拍板）：任何修改都會重產 keyring.json 並自動 git commit + push，
 * 不做「未發布變更」的草稿狀態。發布失敗（例如 repo 還沒開）不影響本機存檔，只回報狀態。
 *
 * 兩邊都能改（本機後台＋手機後台），vault.json 是唯一真本：
 * 每次動手之前先跟 GitHub 對一次時間戳，遠端比較新就整份接受過來（見 refreshFromRemote）。
 *
 * 架構比照 travel-planner/server.js；本工具 port 4620。
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const net = require('net');
const { execFile, spawn, spawnSync, exec } = require('child_process');
/* 多欄位金鑰的共用邏輯（後台 UI 的「幾格」←→「一串」互轉）。
 * 三個地方共用同一份：這裡、public/admin.js、web/admin.js。
 * ⚠️ 它只影響「後台怎麼收集那串字」，儲存與加密格式一個位元組都沒變。 */
const KF = require('./client/keyring-fields.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const WEB_DIR = path.join(ROOT, 'web');
const SECRETS_FILE = path.join(ROOT, 'secrets.json');
const KEYRING_FILE = path.join(ROOT, 'keyring.json');
const VAULT_FILE = path.join(ROOT, 'vault.json');
/* 啟動頁（免密碼那一頁）與它讀的公開清單。⚠️ apps.json 裡一個祕密都不能有，
 * 產生器只有一份：client/keyring-fields.js 的 buildApps()（手機後台呼叫同一支）。 */
const APPS_FILE = path.join(ROOT, 'apps.json');
const LAUNCH_DIR = path.join(ROOT, 'launch');
const LAUNCH_INDEX = path.join(ROOT, 'index.html');
/* 本機記著的 vault 金鑰。放本機是刻意的：這台電腦本來就有明文 PAT，
 * 存了它，存檔時才不用每次再問一次管理密碼。跟 secrets.json 一樣永不上傳。 */
const VAULTKEY_FILE = path.join(ROOT, 'vault.key');
/* 🧰 工具分頁的清單（2026-09-01 從 tool-manager 搬進來，那支之後退役）。
 * ⚠️ 這個檔在 .gitignore 裡，跟 secrets.json 同一級：裡面是這台電腦的絕對路徑、
 *    啟動指令與 env（未來很可能被塞金鑰），而後台存檔跑的是 git add -A ＋ push 到公開 repo。 */
const TOOLS_FILE = path.join(ROOT, 'tools.local.json');

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

/* 「說明」是會原樣顯示在畫面上的文字，不是放金鑰的地方。
 * 實際踩過：一把 32 碼 TMDB 與一把 8 碼 OMDb 被貼進 hint，於是同一格上面是遮罩、
 * 下面是明文。擋在寫入端，讓它不會再發生一次；已經存進去的**不動**（那可能是
 * 那把金鑰的唯一副本，靜靜清掉等於幫人刪金鑰），改由顯示端遮起來。 */
function badHint(fields) { return KF.badFieldText(fields); }

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
/* WebCrypto 把 authTag 接在密文尾巴，Node 要自己拆回來 */
function decryptWithKey(keyBuf, ivB64, cipherB64) {
  const all = Buffer.from(String(cipherB64), 'base64');
  if (all.length < 17) throw new Error('密文太短');
  const tag = all.slice(all.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(String(ivB64), 'base64'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(all.slice(0, all.length - 16)), d.final()]).toString('utf8');
}

/* ------------------------------------------------------------------ */
/* vault.json — 手機後台的加密真本                                      */
/* ------------------------------------------------------------------ */
/*  金鑰 ＝ PBKDF2(管理密碼 + "\n" + 裝置配對碼, salt)
 *
 *  為什麼要配對碼：vault.json 是公開檔案，光靠一組密碼就等於「猜到密碼＝拿到所有 App 的 PAT」。
 *  配對碼是一段隨機碼，只住在裝置裡（手機 localStorage、這台電腦的 vault.key），不進公開檔案，
 *  所以就算整份 vault.json 被抓走、密碼也被猜中，沒有配對碼還是解不開。
 *  手機第一次要貼一次配對碼（或開帶 #pair= 的連結），之後就只要輸密碼。
 */
const PAIR_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32：拿掉 I L O U，唸出來不會錯

function newPairingCode() {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i && i % 4 === 0) out += '-';
    out += PAIR_ALPHABET[bytes[i] % 32];
  }
  return out; // XXXX-XXXX-XXXX-XXXX（80 bits）
}
/* 使用者會打成小寫、會漏掉連字號、會把 O 打成 0 —— 一律先正規化再算金鑰 */
function normalizePairing(s) {
  return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
}
function deriveVaultKey(password, pairing, saltB64) {
  const material = String(password) + '\n' + normalizePairing(pairing);
  return crypto.pbkdf2Sync(
    Buffer.from(material, 'utf8'),
    Buffer.from(saltB64, 'base64'),
    KDF.iter, KDF.keyLen, KDF.hash);
}

/* vault.key（本機）：{ salt, key(base64), pairing, createdAt } */
let V = null;
function loadVaultKey() {
  try {
    const d = JSON.parse(fs.readFileSync(VAULTKEY_FILE, 'utf8'));
    V = (d && d.key && d.salt) ? d : null;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[vault] vault.key 讀取失敗：' + e.message);
    V = null;
  }
}
async function saveVaultKey() {
  await writeFileAtomic(VAULTKEY_FILE, JSON.stringify(V, null, 2) + '\n');
}

/* 真本的內容（＝secrets.json 全部 ＋ 手機要用的 GitHub 寫入金鑰） */
function buildVaultPayload() {
  return {
    version: 1,
    updatedAt: S.updatedAt,
    apps: S.apps.map((a) => {
      const o = {
        id: a.id, name: a.name, emoji: a.emoji, url: a.url || '', token: a.token || '',
        fields: KF.normFields(a.fields), public: !!a.public,
      };
      /* 開場外觀：沒設就整個鍵都不要出現（空值不落地，見 keyring-fields.js 那一段） */
      const sp = KF.normSplash(a.splash);
      if (sp) o.splash = sp;
      /* 啟動頁的三個選填欄位也要進真本，否則手機那邊存一次就把它們洗掉了 */
      if (KF.normRepo(a.repo)) o.repo = KF.normRepo(a.repo);
      if (typeof a.order === 'number' && isFinite(a.order)) o.order = a.order;
      const ke = KF.normKeyExp(a.keyExp);
      if (ke) o.keyExp = ke;
      return o;
    }),
    users: S.users.map((u) => ({
      id: u.id, name: u.name, emoji: u.emoji, theme: u.theme,
      salt: u.salt, dk: u.dk, apps: (u.apps || []).slice(),
    })),
    github: {
      owner: REPO_OWNER, repo: REPO_NAME, branch: 'main',
      token: (S.github && S.github.token) || '',
    },
  };
}
async function writeVault() {
  if (!V) return;
  const e = encryptWithKey(Buffer.from(V.key, 'base64'), JSON.stringify(buildVaultPayload()));
  const doc = {
    version: 1,
    updatedAt: S.updatedAt,
    kdf: { algo: KDF.algo, iter: KDF.iter, salt: V.salt },
    iv: e.iv, cipher: e.cipher,
  };
  await writeFileAtomic(VAULT_FILE, JSON.stringify(doc, null, 2) + '\n');
}
function decryptVaultText(text) {
  if (!V) throw new Error('這台電腦還沒設定手機後台');
  const doc = JSON.parse(text);
  if (!doc || !doc.iv || !doc.cipher) throw new Error('vault.json 格式看不懂');
  if (doc.kdf && doc.kdf.salt && doc.kdf.salt !== V.salt) {
    throw new Error('這份 vault 是用另一組管理密碼／配對碼加密的');
  }
  return JSON.parse(decryptWithKey(Buffer.from(V.key, 'base64'), doc.iv, doc.cipher));
}
/* 把解開的真本接手成這台電腦的 secrets（手機那邊改過東西時走這條） */
function adoptPayload(p) {
  S = {
    version: 1,
    updatedAt: p.updatedAt || new Date().toISOString(),
    apps: (p.apps || []).map((a) => {
      const prev = S.apps.find((x) => x.id === a.id);
      const o = {
        id: a.id, name: a.name, emoji: a.emoji, url: a.url || '', token: a.token || '',
        /* ⚠️ 他手機上還快取著的**舊版後台**不認得 fields／public／splash，送上來的資料
         *    根本沒有那些鍵。那是「這版不認得」不是「他要清空／關掉」→ 保留這台電腦原本的設定。 */
        fields: KF.adoptFields(a, prev),
        public: KF.adoptPublic(a, prev),
      };
      const sp = KF.adoptSplash(a, prev);
      if (sp) o.splash = sp;
      /* 跟 fields／public／splash 同一條規則：舊版手機後台送上來的資料**沒有這幾個鍵**
       * ＝「這版不認得」，不是「他要清掉」→ 保留這台電腦原本的設定。 */
      const has = (k) => a && typeof a === 'object' && Object.prototype.hasOwnProperty.call(a, k);
      const repo = has('repo') ? KF.normRepo(a.repo) : KF.normRepo(prev && prev.repo);
      if (repo) o.repo = repo;
      const order = has('order') ? a.order : (prev && prev.order);
      if (typeof order === 'number' && isFinite(order)) o.order = order;
      const ke = has('keyExp') ? KF.normKeyExp(a.keyExp) : KF.normKeyExp(prev && prev.keyExp);
      if (ke) o.keyExp = ke;
      return o;
    }),
    users: (p.users || []).map((u) => ({
      id: u.id, name: u.name, emoji: u.emoji, theme: u.theme,
      salt: u.salt, dk: u.dk, apps: Array.isArray(u.apps) ? u.apps.slice() : [],
    })),
    github: { token: (p.github && p.github.token) || '' },
  };
}

/* ------------------------------------------------------------------ */
/* secrets.json（這台電腦的工作本；開了手機後台之後，真本是 vault.json）  */
/* ------------------------------------------------------------------ */
/*  {
 *    version, updatedAt,
 *    apps:  [{id,name,emoji,url,token}]                 <- token 是明文，只在這台電腦
 *    users: [{id,name,emoji,theme,salt,dk,apps:[appId]}] <- dk = 派生金鑰(base64)，不存密碼
 *  }
 *  刻意存「派生金鑰」而不是密碼：後台真的看不到任何人的密碼（符合設計規格 1-3），
 *  但又能在「加一個 App 給某人」時直接用他的金鑰加密新條目，不必再問他一次密碼。
 */
let S = { version: 1, updatedAt: null, apps: [], users: [], github: { token: '' } };

function loadSecrets() {
  try {
    const raw = fs.readFileSync(SECRETS_FILE, 'utf8');
    const d = JSON.parse(raw);
    S = {
      version: 1,
      updatedAt: d.updatedAt || null,
      apps: Array.isArray(d.apps) ? d.apps : [],
      users: Array.isArray(d.users) ? d.users : [],
      github: { token: (d.github && d.github.token) || '' },
    };
    S.users.forEach((u) => { if (!Array.isArray(u.apps)) u.apps = []; });
    /* 舊的 secrets.json 沒有 fields → 一律正規化成 []（＝單欄位，行為完全不變） */
    /* 舊的 secrets.json 也沒有 splash → 正規化；沒東西就把那個鍵拿掉（不要留空物件） */
    S.apps.forEach((a) => {
      a.fields = KF.normFields(a.fields); a.public = !!a.public;
      const sp = KF.normSplash(a.splash);
      if (sp) a.splash = sp; else delete a.splash;
      /* 啟動頁用的三個選填欄位（都是「加」，既有格式一個位元組都沒動）：
       * repo＝給啟動頁查上次更新時間用；order＝磚塊順序；keyExp＝到期偵測的結果快取。 */
      const repo = KF.normRepo(a.repo);
      if (repo) a.repo = repo; else delete a.repo;
      if (typeof a.order !== 'number' || !isFinite(a.order)) delete a.order;
      const ke = KF.normKeyExp(a.keyExp);
      if (ke) a.keyExp = ke; else delete a.keyExp;
    });
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[secrets] 讀取失敗，改用空的鑰匙圈：', e.message);
    S = { version: 1, updatedAt: null, apps: [], users: [], github: { token: '' } };
  }
}
/* keepStamp：接手手機那邊的改動時要留著它的時間戳，否則這台電腦會平白變成「比較新」 */
async function saveSecrets(keepStamp) {
  if (!keepStamp) S.updatedAt = new Date().toISOString();
  await writeFileAtomic(SECRETS_FILE, JSON.stringify(S, null, 2) + '\n');
}

/* 產出公開的 keyring.json：只有密文
 * ⚠️ 多欄位金鑰**刻意不改這裡**：欄位宣告是後台自己的事（存在 secrets.json／vault.json），
 *    公開檔的結構維持原樣，client/keyring-unlock.js 與三個 App 都不用動。
 *    加密的還是「一個 App 一串字」，只是那串字現在由後台幫他組好。 */
/* 公開模式：產生 keyring.json 的**那一刻**再擋一次。
 * 為什麼不是只在 API 擋：值可能是「標成公開之後」才被換掉的
 * （他先把 App 設公開，過幾天換金鑰時貼了一把 PAT 進去）。
 * 擋到的話**降級成加密**（fail-safe：祕密留在密文裡），不是整個發布掛掉——
 * 掛掉會讓他連「把公開關掉」都做不到。降級的原因會出現在後台畫面上（viewState 的 publicBlocked）。 */
function publicPlain(app) {
  if (!app || !app.public || !app.token) return null;
  return KF.publicBlockReason(app) ? null : app.token;
}

function buildKeyring() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    apps: S.apps.map((a) => {
      const out = { id: a.id, name: a.name, emoji: a.emoji };
      /* ⭐ 公開的 App：值直接以**明文**放在 apps[] 這一層。
       * 欄位名字刻意叫 plain（跟 iv／cipher 明確分開），讀取端一眼就知道這不是密文。
       * 不綁任何使用者、不需要密碼 —— 那正是「打開網址就能用」的意思。 */
      const plain = publicPlain(a);
      if (a.public && plain !== null) { out.public = true; out.plain = plain; }
      /* ⭐ 開場外觀：跟 public／plain 同一層級的**公開明文**，跟密文完全無關。
       * 沒設定的項目連鍵都不會出現 —— App 端讀不到就用它自己的預設。 */
      const sp = KF.normSplash(a.splash);
      if (sp) out.splash = sp;
      return out;
    }),
    users: S.users.map((u) => {
      const apps = {};
      (u.apps || []).forEach((appId) => {
        const app = S.apps.find((a) => a.id === appId);
        if (!app || !app.token || !u.dk) return;
        /* 公開的 App 不再產生每個人的密文：同一個值有兩個來源只會讓讀取端要猜哪個才算數。
         * （被擋下來而降級的那種還是走密文，所以這裡用 publicPlain 判斷，不是用 a.public） */
        if (publicPlain(app) !== null) return;
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
  /* tools.local.json：本機工具清單。沒有密碼，但有絕對路徑與 env（很容易被塞金鑰），
   * 而且發布跑的是 git add -A → 一樣要在 .gitignore 裡才准發布。 */
  for (const f of ['secrets.json', 'vault.key', 'tools.local.json']) {
    await gitCmd(['check-ignore', '-q', f]).catch(() => {
      throw new Error(f + ' 沒有被 .gitignore 忽略');
    });
  }
  const status = await gitCmd(['status', '--porcelain']);
  if (/secrets\.json|vault\.key|tools\.local\.json/.test(status)) {
    throw new Error('git 看得到 secrets.json、vault.key 或 tools.local.json');
  }
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
async function publish(commitMsg) {
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
        '為了安全，這次沒有發布：' + firstLine(e && e.message) + '。這種檔案一上傳，公開的鑰匙圈就等於直接被解開。',
        ['檢查 keyring 資料夾裡的 .gitignore 有沒有 secrets.json 與 vault.key 這兩行',
         '修好之後按「再試一次」']);
    }

    await gitCmd(['add', '-A']);
    const status = await gitCmd(['status', '--porcelain']);
    if (status.trim()) {
      /* commit message 寫人話 ＋ 誰改的（2026-08-28）。
       * git 的 author 沒有用：這台電腦一律是 LAPTOP-…\USER，手機端全部是 xd1104。
       * 電腦後台沒有登入身分，所以 by 是空的 —— **誠實留白，不要編一個名字**。 */
      await gitCmd(['commit', '-m', commitMsg || KF.commitMessage({ via: '電腦後台' })]);
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

/* 啟動頁的公開清單 apps.json（2026-08-28）
 * ⚠️ 只用 KF.buildApps() 產（白名單），server 這邊**不准**自己拼一份出來——
 *    手機後台呼叫的是同一支，驗收會比對「兩端產出逐位元組相同」。
 * 產不出來的時候（名字／圖示裡被貼了金鑰）**不寫、不降級**，把原因留在狀態列上給他看。 */
let appsState = { ok: true, at: null, message: '' };
async function writeAppsFile(stamp) {
  try {
    await writeFileAtomic(APPS_FILE, KF.appsJsonText({ apps: S.apps, generatedAt: stamp }));
    appsState = { ok: true, at: new Date().toISOString(), message: '' };
  } catch (e) {
    appsState = { ok: false, at: new Date().toISOString(), message: firstLine(e && e.message) };
    console.error('[apps.json] ' + appsState.message);
  }
}

/* 每次異動：重產 keyring.json -> 存 secrets.json -> 產 apps.json -> 存 vault.json -> 自動發布
 * action ＝ 這次做了什麼（人話，會變成 commit 的第一行）。呼叫端最清楚，所以由它給。 */
async function commitChanges(action) {
  let before = null;
  try { before = JSON.parse(fs.readFileSync(KEYRING_FILE, 'utf8')); } catch (e) { /* 第一次還沒有 */ }
  await saveSecrets();
  const ring = buildKeyring();
  await writeFileAtomic(KEYRING_FILE, JSON.stringify(ring, null, 2) + '\n');
  await writeAppsFile(ring.updatedAt);
  await writeVault();
  /* 結構差異是備援：呼叫端沒給人話時才用它推。⚠️ 密文每次存檔都會變（IV 是隨機的），
   * 所以「換了金鑰」這種事推不出來，一定要靠 action。 */
  const msg = KF.commitMessage({ action, diffs: KF.summarizeChange(before, ring), via: '電腦後台' });
  return publish(msg);
}

/* ------------------------------------------------------------------ */
/* 變更紀錄（近況）                                                     */
/* ------------------------------------------------------------------ */
/* 從 git log 讀，只解析 message（手機那邊解析同一種格式，兩邊畫面組法一樣）。
 * ⚠️ 誠實條款：存檔跑的是 git add -A，一筆 commit 可能夾帶別的檔案。
 *    otherFiles 就是那個數量，畫面要照實說「這次同時改到 N 個其他檔案」。 */
const RING_FILES = ['keyring.json', 'vault.json', 'apps.json'];
async function gitHistory(limit) {
  const n = Math.max(1, Math.min(200, Number(limit) || 30));
  const out = await gitCmd(['log', '-n', String(n * 2), '--name-only',
    '--format=%x1e%H%x1f%aI%x1f%an%x1f%B%x1f']);
  const rows = [];
  out.split('\x1e').forEach((block) => {
    if (!block.trim()) return;
    const parts = block.split('\x1f');
    if (parts.length < 5) return;
    const files = parts[4].split('\n').map((s) => s.trim()).filter(Boolean);
    const touched = files.filter((f) => RING_FILES.indexOf(f) >= 0);
    if (!touched.length) return;              /* 不是鑰匙圈的改動（例如我自己改程式）就不列 */
    const p = KF.parseCommitMessage(parts[3]);
    rows.push({
      sha: parts[0].slice(0, 7), at: parts[1], author: parts[2],
      title: p.title, by: p.by, via: p.via, tagged: p.tagged,
      otherFiles: files.length - touched.length,
    });
  });
  return rows.slice(0, n);
}

/* ------------------------------------------------------------------ */
/* 金鑰到期偵測                                                        */
/* ------------------------------------------------------------------ */
/* ⛔ 鐵律：**用那個 App 自己的那把 token 打它自己的 repo**。
 *    不可以拿鑰匙圈那把（或別的 App 那把）去測 —— 那等於讓金鑰跨 App 流動。
 * ⛔ 明文 token 只在這支程式裡用一次，不進任何 HTTP 回應、不進 apps.json。
 * 只有長得像 GitHub token 的才送得出去：TMDB／OMDb 那種金鑰送去 GitHub 毫無意義，
 * 而且等於把一把別家的金鑰交給第三方。 */
function ghProbe(token, repo) {
  return new Promise((resolve) => {
    const req = https.request({
      host: 'api.github.com',
      path: repo ? '/repos/' + repo : '/user',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'keyring-admin',
      },
      timeout: 8000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({
        status: res.statusCode,
        exp: res.headers['github-authentication-token-expiration'] || '',
      }));
    });
    req.on('error', () => resolve({ status: 0, exp: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, exp: '' }); });
    req.end();
  });
}
/* 回傳 { changed, message }；結果寫進 a.keyExp（那是快取，不是設定）。
 * changed ＝ 「結果本身」變了（不看 checkedAt）：只有變了才值得產生一筆 commit，
 * 否則每按一次「重新檢查」就多一筆什麼都沒改的紀錄，近況那一頁會被洗版。 */
function keyExpFingerprint(k) {
  const n = KF.normKeyExp(k);
  return n ? JSON.stringify([n.expiresAt, n.source, n.state]) : '';
}
async function checkAppKey(a) {
  const was = keyExpFingerprint(a && a.keyExp);
  const r = await checkAppKeyRaw(a);
  return { changed: keyExpFingerprint(a && a.keyExp) !== was, message: r.message };
}
async function checkAppKeyRaw(a) {
  const token = String((a && a.token) || '').trim();
  if (!token) return { message: '這個 App 沒有金鑰，沒有東西可以測' };
  if (!KF.looksLikeGithubToken(token)) {
    return { message: '這個 App 的金鑰不是 GitHub 金鑰，測不到到期日（可以自己填一個）' };
  }
  const repo = KF.normRepo(a.repo) || KF.repoFromUrl(a.url);
  const r = await ghProbe(token, repo);
  const now = new Date().toISOString();
  const prev = KF.normKeyExp(a.keyExp);
  if (r.status >= 200 && r.status < 300) {
    const exp = KF.expiryFromHeader(r.exp);
    /* 自動測到就覆蓋手動填的值並標回 auto（自動比人記得準）。 */
    a.keyExp = exp
      ? { expiresAt: exp, source: 'auto', checkedAt: now, state: 'ok' }
      : { expiresAt: null, source: 'auto', checkedAt: now, state: 'none' };
    return { message: exp ? ('這把到 ' + exp + ' 過期') : '這把不會過期' };
  }
  if (r.status === 401) {
    a.keyExp = { expiresAt: (prev && prev.expiresAt) || null, source: 'auto', checkedAt: now, state: 'expired' };
    return { message: 'GitHub 說這把已經無效了（過期或被撤銷）' };
  }
  /* 403／404／連不上：**測不到，不是沒事**。手動填過的值也不覆蓋（自動測不到時人比較準）。 */
  if (!prev) {
    a.keyExp = { expiresAt: null, source: 'auto', checkedAt: now, state: 'unknown' };
  } else {
    a.keyExp = Object.assign({}, prev, { checkedAt: now });
  }
  return {
    message: r.status ? ('這次測不到（GitHub 回 ' + r.status + '），維持上一次的結果') : '連不到 GitHub，這次沒測到',
  };
}

/* ------------------------------------------------------------------ */
/* 跟手機那邊對時（vault.json 是唯一真本）                               */
/* ------------------------------------------------------------------ */
/*  兩邊都能改，所以動手之前一定要先看一眼 GitHub：
 *    遠端 vault 比較新 -> 整份接受過來（merge -X theirs，再從 vault 重建 secrets.json）
 *    否則              -> 維持本機（merge -X ours）
 *  用時間戳而不是逐檔合併，是因為這三個檔案是同一份資料的三種樣子，各合各的只會合出壞資料。
 *  沒設定手機後台（沒有 vault.key）就整段跳過，行為跟以前一模一樣。 */
let syncState = { ok: true, at: null, message: '', adopted: false };

async function refreshFromRemote() {
  if (!V) return syncState;
  let branch = 'main';
  try {
    await gitCmd(['rev-parse', '--is-inside-work-tree']);
    await gitCmd(['remote', 'get-url', 'origin']);
    branch = (await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main';
  } catch (e) {
    return syncState; // 還沒接上 GitHub：publish() 那條狀態列已經在講這件事了
  }
  try {
    /* 先把本機沒 commit 的東西收乾淨，merge 才不會被擋下來 */
    await assertSecretsSafe();
    await gitCmd(['add', '-A']);
    if ((await gitCmd(['status', '--porcelain'])).trim()) {
      await gitCmd(['commit', '-m', KF.commitMessage({ action: '先把這台電腦上還沒送出去的改動收起來', via: '電腦後台' })]);
    }
    await gitCmd(['fetch', 'origin', branch]);

    let remoteVault = null;
    try { remoteVault = JSON.parse(await gitCmd(['show', 'origin/' + branch + ':vault.json'])); } catch { /* 遠端還沒有 */ }
    const remoteAt = (remoteVault && remoteVault.updatedAt) || '';
    const localAt = S.updatedAt || '';
    const adopt = !!remoteAt && remoteAt > localAt;

    await gitCmd(['merge', '--no-edit', '-X', adopt ? 'theirs' : 'ours', 'origin/' + branch]);

    if (adopt) {
      adoptPayload(decryptVaultText(fs.readFileSync(VAULT_FILE, 'utf8')));
      await saveSecrets(true); // 留著手機那邊的時間戳
      syncState = { ok: true, at: new Date().toISOString(), message: '接手了手機那邊的改動', adopted: true };
      console.log('[sync] 遠端比較新，已接手（' + remoteAt + '）');
    } else {
      syncState = { ok: true, at: new Date().toISOString(), message: '', adopted: false };
    }
  } catch (e) {
    syncState = { ok: false, at: new Date().toISOString(), adopted: false,
      message: '跟 GitHub 對時沒成功：' + firstLine(e && e.message) };
    console.error('[sync] ' + syncState.message);
  }
  return syncState;
}

/* 動手之前先對時；對時失敗不擋改動（本機一定存得下去），只把原因記在狀態列 */
async function beforeChange() {
  if (V) await refreshFromRemote();
}

/* ------------------------------------------------------------------ */
/* 給前端的視圖（明文 token 永遠不出這台機器、也不回傳給瀏覽器）           */
/* ------------------------------------------------------------------ */
function viewState() {
  return {
    apps: S.apps.map((a) => {
      const fields = KF.normFields(a.fields);
      /* ⭐ 說明（hint）是自由文字，而且是**設計來顯示在畫面上**的。實際發生過有人
       *    把真金鑰貼進去（見 keyring-fields.js 的說明），所以這裡也要過一次遮罩：
       *    「API 從不吐明文金鑰」這條不變式不能只管 token 那一欄，任何一個會被
       *    原樣印到畫面上的欄位都算。hintHidden 讓編輯器知道要清空重填而不是把
       *    警告字串當成他原本的說明存回去。 */
      const safeFields = fields.map((f) => ({
        key: f.key, optional: f.optional,
        label: KF.safeLabel(f.label, f.key), labelHidden: KF.secretishDeep(f.label),
        hint: KF.safeHint(f.hint), hintHidden: KF.secretishDeep(f.hint),
      }));
      return {
        id: a.id, name: a.name, emoji: a.emoji, url: a.url || '',
        masked: KF.maskSummary(fields, a.token, maskToken), hasToken: !!a.token,
        /* 啟動頁那三個欄位。⚠️ key 是**算好的狀態**（ok/soon/expired/none/unknown），
         *    不是金鑰本身，也不含任何明文。 */
        repo: KF.normRepo(a.repo) || '', repoGuess: KF.repoFromUrl(a.url || ''),
        order: typeof a.order === 'number' ? a.order : null,
        keyed: !!a.token,
        key: KF.keyExpState(a.keyExp, new Date().toISOString()),
        fields: safeFields,
        /* ⭐ 每一格只給**遮罩**。後台的 HTTP API 從來不吐明文金鑰，即使 server 自己手上有——
         *    這是這個系統刻意的不變式（憑證保管系統），不要為了任何便利開這個口。
         *    「把他以前手打的那串拆回幾格」是在 server 端做完、直接存回去，明文不出這支程式。 */
        fieldsMasked: fields.length ? KF.maskedFields(fields, a.token) : [],
        /* 多欄位的 App 才會有：那串字目前拆不拆得開（拆不開時後台要提醒他確認） */
        fieldsOk: fields.length ? KF.parse(fields, a.token).ok : true,
        /* 公開模式：是不是公開、以及「勾了公開但被擋下來」的原因（值長得像 GitHub token） */
        public: !!a.public,
        publicBlocked: !!a.public && !!KF.publicBlockReason(a),
        publicBlockReason: a.public ? KF.publicBlockReason(a) : '',
        /* 開場外觀：本來就是公開明文，回給畫面沒有任何顧慮（沒設定就是 null） */
        splash: KF.normSplash(a.splash),
        users: S.users.filter((u) => (u.apps || []).indexOf(a.id) >= 0).map((u) => u.id),
      };
    }),
    users: S.users.map((u) => ({
      id: u.id, name: u.name, emoji: u.emoji, theme: u.theme, apps: (u.apps || []).slice(),
    })),
    publish: pubState,
    sync: syncState,
    /* 啟動頁的公開清單產得出來嗎（產不出來要講原因，不要靜靜跳過） */
    appsFile: appsState,
    launchUrl: 'https://' + REPO_OWNER + '.github.io/' + REPO_NAME + '/',
    vault: vaultState(),
    updatedAt: S.updatedAt,
  };
}

/* 手機後台的狀態（配對碼會回傳：它本來就要唸給手機聽，而且沒有密碼也沒用） */
function vaultState() {
  return {
    enabled: !!V,
    pairing: V ? V.pairing : '',
    createdAt: V ? V.createdAt : null,
    ghMasked: maskToken((S.github && S.github.token) || ''),
    hasGh: !!(S.github && S.github.token),
    webUrl: 'https://' + REPO_OWNER + '.github.io/' + REPO_NAME + '/web/',
  };
}

function findUser(id) { return S.users.find((u) => u.id === id) || null; }
function findApp(id) { return S.apps.find((a) => a.id === id) || null; }
/* 啟動頁磚塊的排序值：沒設過 order 的照陣列順序排在一起（跟 KF.buildApps 同一條規則） */
function ordOf(a) {
  return (typeof a.order === 'number' && isFinite(a.order)) ? a.order : S.apps.indexOf(a);
}

/* 從請求裡取出「要存進 token 的那一串字」。
 * 多欄位 App 收 values（幫他組），單欄位收 token（原樣）。都沒帶就回 null＝不要動它。 */
function composeToken(app, b) {
  const fields = KF.normFields(app && app.fields);
  if (fields.length && b && b.values && typeof b.values === 'object') {
    return KF.compose(fields, b.values, b.extra || {});
  }
  const t = String((b && b.token) || '').trim();
  return t ? t : null;
}

/* ================================================================== */
/* 🧰 工具（本機程式的啟動／停止）                                       */
/*                                                                    */
/* 2026-09-01 從 tool-manager（原本自己一支 port 4900 的面板）整支搬進來， */
/* 那支之後退役。⚠️ 這一段是**照抄它踩過雷的實作**，不是重寫：             */
/*   ① Windows 要用 taskkill /t /f 殺**整棵** process tree              */
/*      （npm／electron／python 會生一堆孫程序，只殺 pid 會留孤兒）；      */
/*   ② 程序掃描（Get-CimInstance）一次要一秒，所以配 5 秒 TTL 快取；       */
/*   ③ 掃描比對時要排除「管理器自己 spawn 的子孫」，否則自己開的會被        */
/*      再判定成「外部已在跑」；                                          */
/*   ④ 有 port 的工具 spawn 後有 20 秒寬限期顯示「啟動中」，              */
/*      過了寬限期 port 還沒通也照樣算 running（程序活著），不要永遠卡住。  */
/*                                                                    */
/* ⚠️ 這裡不能出現在啟動頁（GitHub Pages 的公開靜態頁）也不能出現在手機後台： */
/*    那兩邊都沒有這台電腦的 server，本機程式**永遠**啟動不了。只有電腦端    */
/*    後台（127.0.0.1:4620）做得到。                                     */
/* ⚠️ 鑰匙圈自己刻意不在清單裡——它就是面板本身，server 沒開你連這頁都看不到。*/
/*    （先例：tool-manager 最後一筆 commit 把早盤儀表板移除，理由同一條。）  */
/* 依賴：只用 node 內建（child_process／net），維持零執行期依賴。          */
/* ================================================================== */

const MAX_LOG_LINES = 500;
const STARTING_GRACE_MS = 20000;
/* 重啟＝先殺掉、隔一下再開。這段空窗要讓 taskkill 把 port 放掉。 */
const RESTART_DELAY_MS = 1200;

/* 每個工具的執行期狀態 { child, pid, startedAt, pendingUntil, logs:[] }
 * pendingUntil：重啟的空窗期。這段時間程序已經死了、新的還沒生出來，
 * 不記一筆的話狀態會算成「沒在跑」——按了重啟卻顯示沒在跑，看起來像按鈕壞了。 */
const toolState = new Map();
function getToolState(id) {
  if (!toolState.has(id)) toolState.set(id, { child: null, pid: null, startedAt: 0, pendingUntil: 0, logs: [] });
  return toolState.get(id);
}

/* 清單狀態：讀不到就要**講原因**，不要靜靜給一張空清單（那長得像「你沒有工具」）。 */
let toolsState = { ok: true, message: '' };

/* 每次讀都熱重讀（改 tools.local.json 不用重開後台） */
function readTools() {
  let raw;
  try {
    raw = fs.readFileSync(TOOLS_FILE, 'utf8');
  } catch (e) {
    toolsState = { ok: false, message: '找不到 tools.local.json（本機工具清單）。它在 ' + TOOLS_FILE };
    return [];
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    toolsState = { ok: false, message: 'tools.local.json 讀不懂（JSON 格式壞了）：' + firstLine(e && e.message) };
    return [];
  }
  if (!Array.isArray(list)) {
    toolsState = { ok: false, message: 'tools.local.json 必須是一個陣列' };
    return [];
  }
  toolsState = { ok: true, message: '' };
  /* 防呆：就算有人把舊的 tools.json 整份貼回來，鑰匙圈自己也不會冒出來 */
  return list.filter((t) => t && t.id && t.id !== 'keyring');
}
function findTool(id) { return readTools().find((t) => t.id === id) || null; }

function pushToolLog(st, text, tag) {
  const ts = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    st.logs.push('[' + ts + ']' + (tag ? ' ' + tag : '') + ' ' + line);
  }
  if (st.logs.length > MAX_LOG_LINES) st.logs.splice(0, st.logs.length - MAX_LOG_LINES);
}

function isManaged(st) { return st.child !== null; }

function startTool(tool) {
  const st = getToolState(tool.id);
  if (isManaged(st)) return { ok: false, message: '已在運行中（由這個面板啟動）' };
  const env = Object.assign({}, process.env, tool.env || {});
  let child;
  try {
    child = spawn(tool.command, { cwd: tool.cwd, shell: true, windowsHide: true, env });
  } catch (e) {
    pushToolLog(st, '啟動失敗：' + e.message, '⚙');
    return { ok: false, message: '啟動失敗：' + e.message };
  }
  st.child = child;
  st.pid = child.pid;
  st.startedAt = Date.now();
  st.pendingUntil = 0;          /* 真的開起來了，空窗結束 */
  pushToolLog(st, '啟動：' + tool.command + '（pid ' + child.pid + '）', '⚙');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => pushToolLog(st, d));
  child.stderr.on('data', (d) => pushToolLog(st, d, '⚠'));
  child.on('error', (e) => { pushToolLog(st, '程序錯誤：' + e.message, '⚙'); st.child = null; });
  child.on('exit', (code, signal) => {
    pushToolLog(st, '程序結束（code=' + code + (signal ? ', signal=' + signal : '') + '）', '⚙');
    st.child = null;
  });
  return { ok: true, pid: child.pid };
}

/* ⚠️ Windows 一定要 /t（整棵樹）＋ /f（強制）。npm run dev 那種是
 * cmd → npm → node → electron 一長串，只殺最上面那個會留一堆孤兒。 */
function killTree(pid) {
  return spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
}

function stopTool(tool) {
  const st = getToolState(tool.id);
  if (!isManaged(st)) return { ok: false, message: '不是這個面板開的，這裡停不了（去原本開它的視窗關）' };
  const pid = st.child.pid;
  killTree(pid);
  pushToolLog(st, '停止（taskkill /pid ' + pid + ' /t /f）', '⚙');
  st.child = null;   /* exit 事件也會清，先清一次避免競態 */
  return { ok: true };
}

/* ---- 程序掃描（processMatch：偵測「不是我開的但已經在跑」） ---- */
const PROC_CACHE_TTL = 5000;
let procCache = { ts: 0, list: [] };
let procScanInflight = null;

function scanProcesses() {
  if (Date.now() - procCache.ts < PROC_CACHE_TTL) return Promise.resolve(procCache.list);
  if (procScanInflight) return procScanInflight;
  procScanInflight = new Promise((resolve) => {
    exec(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"',
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        procScanInflight = null;
        if (err) return resolve(procCache.list);      /* 掃描失敗就用舊快取，不要謊報成「沒在跑」 */
        try {
          let list = JSON.parse(stdout);
          if (!Array.isArray(list)) list = list ? [list] : [];
          procCache = { ts: Date.now(), list };
          resolve(list);
        } catch (_) { resolve(procCache.list); }
      }
    );
  });
  return procScanInflight;
}
function invalidateProcCache() { procCache.ts = 0; }

/* 「後台自己 ＋ 它 spawn 的所有子孫」的 PID 集合。比對 processMatch 時要排除，
 * 否則自己開的工具會同時被判成「我開的」與「外部已在跑」。 */
function managerSubtreePids(list) {
  const childrenOf = new Map();
  for (const proc of list) {
    if (!proc || typeof proc.ProcessId !== 'number') continue;
    const ppid = proc.ParentProcessId;
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(proc.ProcessId);
  }
  const subtree = new Set();
  const queue = [process.pid];
  while (queue.length) {
    const pid = queue.pop();
    if (subtree.has(pid)) continue;
    subtree.add(pid);
    for (const c of childrenOf.get(pid) || []) queue.push(c);
  }
  return subtree;
}

async function findExternalPids(tool) {
  if (!tool.processMatch) return [];
  const needle = String(tool.processMatch).toLowerCase();
  const list = await scanProcesses();
  const exclude = managerSubtreePids(list);
  const pids = [];
  for (const proc of list) {
    if (!proc || !proc.CommandLine) continue;
    if (exclude.has(proc.ProcessId)) continue;
    const cl = String(proc.CommandLine).toLowerCase();
    if (cl.includes('win32_process')) continue;      /* 掃描指令本身 */
    if (cl.includes(needle)) pids.push(proc.ProcessId);
  }
  return pids;
}

function probePort(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; sock.destroy(); resolve(ok); };
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function buildToolStatus(tool) {
  const st = getToolState(tool.id);
  const managed = isManaged(st);
  let portOpen = false;
  let externalPids = [];
  if (!managed) {
    if (tool.port) portOpen = await probePort(tool.port);
    if (tool.processMatch) externalPids = await findExternalPids(tool);
  } else if (tool.port) {
    portOpen = await probePort(tool.port);
  }

  let status;              /* running | starting | stopped */
  let external = false;
  const pending = st.pendingUntil > Date.now();   /* 重啟的空窗期 */
  if (managed) {
    if (tool.port) {
      /* port 一直沒開也還是 running（程序活著），避免永遠卡在「啟動中」 */
      status = portOpen ? 'running' : (Date.now() - st.startedAt < STARTING_GRACE_MS ? 'starting' : 'running');
    } else {
      status = 'running';
    }
  } else if (pending) {
    /* 舊的殺掉了、新的還沒起來。這裡回 stopped 的話畫面會寫「沒在跑」。 */
    status = 'starting';
  } else if (portOpen || externalPids.length > 0) {
    status = 'running';
    external = true;       /* 不是這個面板開的（例如他自己雙擊了 start.bat） */
  } else {
    status = 'stopped';
  }

  return {
    id: tool.id,
    name: tool.name,
    emoji: tool.emoji || '🔧',
    description: tool.description || '',
    category: tool.category || '其他',
    port: tool.port || null,
    url: tool.url || null,
    status, external, managed,
    pending,                 /* 正在重啟的空窗期（畫面要寫「重新啟動中」而不是「沒在跑」） */
    pid: managed ? st.pid : (externalPids[0] || null),
    /* processMatch 比對到的有 PID，可以在這裡停；只靠 port 探到的拿不到 PID，停不了 */
    stoppable: managed || externalPids.length > 0,
    logLines: st.logs.length,
  };
}

/* 後台關掉時，把自己 spawn 的工具一起收乾淨，不留孤兒 */
let toolsCleaned = false;
function cleanupTools() {
  if (toolsCleaned) return;
  toolsCleaned = true;
  for (const [, st] of toolState) {
    if (st.child && st.child.pid) { try { killTree(st.child.pid); } catch (_) {} }
  }
}
process.on('exit', cleanupTools);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanupTools(); process.exit(0); });
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

/* ⚠️ 加了「能啟動任意本機程序」之後，光綁 127.0.0.1 還不夠：
 * 任何網頁都可以對 http://127.0.0.1:4620 送一個跨來源 POST（simple request 不觸發預檢，
 * 回應讀不到但**副作用會發生**）。所以：
 *   ① Host 一定要是 localhost／127.0.0.1（擋 DNS rebinding）；
 *   ② 有 Origin 的話一定要是我們自己這一頁（瀏覽器跨來源 POST 必帶 Origin）。
 * 沒有 Origin 的（curl／測試工具／本機腳本）放行——那已經是「這台電腦上的程式」，
 * 它本來就有完整權限，擋它沒有意義。 */
function hostOk(req) {
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  return o === 'http://localhost:' + PORT || o === 'http://127.0.0.1:' + PORT;
}

async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const m = req.method;

  if (!hostOk(req)) return sendJson(res, 403, { ok: false, message: '這個後台只接受本機連線' });
  if (m !== 'GET' && !originOk(req)) {
    return sendJson(res, 403, { ok: false, message: '這個要求不是從鑰匙圈後台送來的，擋掉了' });
  }

  if (p === '/state' && m === 'GET') return sendJson(res, 200, { ok: true, state: viewState() });

  /* 近況（變更紀錄）：只解析 commit message，不碰任何檔案內容 */
  if (p === '/history' && m === 'GET') {
    try {
      const rows = await gitHistory(url.searchParams.get('limit'));
      return sendJson(res, 200, { ok: true, entries: rows });
    } catch (e) {
      return sendJson(res, 200, { ok: true, entries: [],
        message: '讀不到變更紀錄（這個資料夾還沒接上 git？）：' + firstLine(e && e.message) });
    }
  }

  /* ---- 🧰 工具（本機程式的啟動／停止） ----
   * ⚠️ 放在 beforeChange() **之前**是刻意的：啟動一個本機工具跟鑰匙圈的資料
   *    一點關係都沒有，不該為了按一下「啟動」就去跟 GitHub 對一次時間戳。 */
  if (p === '/tools' && m === 'GET') {
    const tools = readTools();
    const list = await Promise.all(tools.map(buildToolStatus));
    return sendJson(res, 200, { ok: true, tools: list, file: toolsState });
  }
  const tm = p.match(/^\/tools\/([^/]+)\/(start|stop|restart|logs)$/);
  if (tm) {
    const id = decodeURIComponent(tm[1]);
    const action = tm[2];
    const tool = findTool(id);
    if (!tool) return sendJson(res, 404, { ok: false, message: '找不到這個工具：' + id });

    if (action === 'logs' && m === 'GET') {
      return sendJson(res, 200, { ok: true, id, logs: getToolState(id).logs });
    }
    if (m !== 'POST') return sendJson(res, 405, { ok: false, message: '這支只收 POST' });

    if (action === 'start') {
      /* port 已經被外部占著就擋下來，不要開第二份去撞 port */
      if (tool.port && !isManaged(getToolState(id)) && (await probePort(tool.port))) {
        return sendJson(res, 409, { ok: false,
          message: 'port ' + tool.port + ' 已經有東西在用（外部啟動中），先把那個視窗關掉' });
      }
      if (!isManaged(getToolState(id)) && tool.processMatch) {
        const pids = await findExternalPids(tool);
        if (pids.length > 0) {
          return sendJson(res, 409, { ok: false,
            message: '已經有外部程序在跑了（pid ' + pids.join('、') + '），先停掉它' });
        }
      }
      const r = startTool(tool);
      invalidateProcCache();
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (action === 'stop') {
      const st = getToolState(id);
      if (isManaged(st)) {
        const r = stopTool(tool);
        invalidateProcCache();
        return sendJson(res, 200, r);
      }
      /* 外部啟動但有 processMatch → 找得到 PID，一樣 taskkill 整棵樹 */
      if (tool.processMatch) {
        const pids = await findExternalPids(tool);
        if (pids.length > 0) {
          for (const pid of pids) killTree(pid);
          invalidateProcCache();
          pushToolLog(st, '停止外部程序（taskkill /pid ' + pids.join('、') + ' /t /f）', '⚙');
          return sendJson(res, 200, { ok: true, pids });
        }
      }
      return sendJson(res, 200, { ok: false,
        message: '不是這個面板開的，這裡停不了（去原本開它的視窗關）' });
    }
    if (action === 'restart') {
      const st = getToolState(id);
      if (isManaged(st)) stopTool(tool);
      /* 先把空窗記起來再排程：不然中間這 1.2 秒問狀態會答「沒在跑」。
       * 多給 STARTING_GRACE_MS，讓「起來了但 port 還沒開」也一路顯示啟動中。 */
      st.pendingUntil = Date.now() + RESTART_DELAY_MS + STARTING_GRACE_MS;
      pushToolLog(st, '重啟中…', '⚙');
      setTimeout(() => {
        const r = startTool(tool);
        if (!r.ok) st.pendingUntil = 0;   /* 開不起來就別再假裝啟動中 */
      }, RESTART_DELAY_MS);
      invalidateProcCache();
      return sendJson(res, 200, { ok: true, message: '重啟排好了' });
    }
  }

  /* 兩邊都能改：任何寫入之前先跟 GitHub 對一次時間戳，免得蓋掉手機那邊剛改的東西。
   * （設定手機後台本身、發布、接線這幾支自己處理，不走這條） */
  if (m !== 'GET' && p !== '/publish' && p !== '/setup' && p !== '/sync') {
    await beforeChange();
  }

  if (p === '/sync' && m === 'POST') {
    await refreshFromRemote();
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  /* ---- 手機後台（vault） ---- */
  if (p === '/vault' && m === 'POST') {
    const b = await readJson(req);
    const pw = String(b.password || '');
    if (pw.length < 8) return sendJson(res, 400, { ok: false, message: '管理密碼至少 8 個字（這一組等於所有 App 的金鑰）' });
    const pairing = (V && !b.newPairing) ? V.pairing : newPairingCode();
    const salt = crypto.randomBytes(16).toString('base64');
    V = {
      salt, pairing,
      key: deriveVaultKey(pw, pairing, salt).toString('base64'),
      createdAt: (V && V.createdAt) || new Date().toISOString(),
    };
    await saveVaultKey();
    await commitChanges('設定了手機後台');
    return sendJson(res, 200, { ok: true, state: viewState() });
  }
  if (p === '/vault' && m === 'DELETE') {
    V = null;
    await fsp.unlink(VAULTKEY_FILE).catch(() => {});
    await fsp.unlink(VAULT_FILE).catch(() => {});
    await commitChanges('關掉了手機後台');
    return sendJson(res, 200, { ok: true, state: viewState() });
  }
  if (p === '/vault/github' && m === 'POST') {
    const b = await readJson(req);
    const token = String(b.token || '').trim();
    if (!token) return sendJson(res, 400, { ok: false, message: '先貼上 GitHub 金鑰' });
    if (!S.github) S.github = { token: '' };
    S.github.token = token;
    await commitChanges('換了手機後台寫回 GitHub 的金鑰');
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  /* 這兩支「請求本身」一定算成功（HTTP 200 + ok:true）；
   * 發布結果看 state.publish，才不會讓前端把「發布沒成功」講成「失敗（200）」 */
  if (p === '/publish' && m === 'POST') {
    await commitChanges('');
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
    /* 有送 apps 就完全照他勾的（包括「一個都不勾」＝真的收得掉）；
     * 沒送＝新增使用者的預設＝所有 App 都給（他要管的只有成員）。
     * 更新既有使用者時刻意不套這個預設，否則他取消的勾會被系統自己加回去。 */
    const sent = Array.isArray(b.apps);
    const apps = sent ? b.apps.filter((x) => !!findApp(x)) : S.apps.map((x) => x.id);
    let u = b.id ? findUser(b.id) : null;
    let created = false;
    if (u) {
      u.name = name; u.emoji = b.emoji || u.emoji; u.theme = b.theme || u.theme;
      if (sent) u.apps = apps;
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
      created = true;
    }
    await commitChanges(created ? ('新增成員「' + name + '」') : ('改了成員「' + name + '」'));
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
    await commitChanges('換了「' + u.name + '」的密碼');
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  mt = p.match(/^\/users\/([^/]+)$/);
  if (mt && m === 'DELETE') {
    const id = decodeURIComponent(mt[1]);
    const gone = findUser(id);
    S.users = S.users.filter((u) => u.id !== id);
    await commitChanges('移除成員「' + ((gone && gone.name) || id) + '」');
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  /* ---- App 金鑰 ---- */
  if (p === '/apps' && m === 'POST') {
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (!name) return sendJson(res, 400, { ok: false, message: '先給它一個名字' });
    /* 名字／圖示／網址／repo 會原樣進**公開的** apps.json（啟動頁在讀）。
     * 這個 repo 已經有三次「金鑰被貼進自由文字欄」的前科，所以寫入端先擋一次。 */
    {
      const whyPub = KF.appsBlockReason([{ id: b.appId || name, name, emoji: b.emoji, url: b.url, repo: b.repo }]);
      if (whyPub) return sendJson(res, 400, { ok: false, message: whyPub });
    }
    /* 多欄位：後台可以宣告這個 App 要哪幾格。沒帶 fields 就是單欄位（現況，行為不變）。 */
    const wantFields = b.fields === undefined ? null : KF.normFields(b.fields);
    if (wantFields) {
      const badNew = badHint(wantFields);
      if (badNew) return sendJson(res, 400, { ok: false, message: badNew });
    }
    /* 公開旗標：沒帶就不動（預設一律加密；新 App 沒帶就是 false） */
    const wantPublic = b.public === undefined ? null : !!b.public;
    let a = b.id ? findApp(b.id) : null;
    const isNew = !a;
    if (a) {
      a.name = name; a.emoji = b.emoji || a.emoji; a.url = String(b.url || a.url || '');
      /* repo 只在有送這個鍵的時候才動（舊版後台不認得它，見 adoptPayload 那條規則） */
      if (b.repo !== undefined) { const r = KF.normRepo(b.repo); if (r) a.repo = r; else delete a.repo; }
      if (wantFields) a.fields = wantFields;
      const tk = composeToken(a, b);
      if (tk !== null) a.token = tk;
      if (wantPublic !== null) {
        if (wantPublic) {
          const why = KF.publicBlockReason(a);
          if (why) return sendJson(res, 400, { ok: false, message: why });
        }
        a.public = wantPublic;
      }
    } else {
      /* ⛔ 這裡**刻意不沿用**別的 App 的金鑰（2026-08-24 Benson 拍板改回來）。
       * 舊版為了省事，沒貼金鑰時會自動抄「最後一個有金鑰的 App」的那把。
       * 那等於讓金鑰在 App 之間流動，直接違反這個專案的鐵律：
       *   **每個 App 一把 fine-grained PAT、只授權它自己那一個 repo**。
       * 實際後果：新登記的「電影評分」明明只需要 TMDB／OMDb 金鑰，卻被塞了一把
       * 能寫 travel-book 的 GitHub PAT（三個 App 的 token 指紋一模一樣）。
       * 代價是接新 App 每次都要貼一把——那正是這條界線該有的成本，不要再優化掉。 */
      const token = String(b.token || '').trim();
      /* App id 是 Benson 自己填的代號（要跟該 App 前端的 appId 一致），一樣只收 ASCII */
      const wanted = slugify(b.appId || name);
      /* 同一個代號再登記一次，多半是打錯或忘了已經加過。以前會靜靜長出 xxx-2，
       * 而那個 id 沒有任何 App 前端在用＝一筆沒用的殭屍。直接擋下來講清楚。 */
      if (wanted && findApp(wanted)) {
        return sendJson(res, 400, { ok: false,
          message: '已經有一個代號叫「' + wanted + '」的 App 了。要改它的名字或金鑰請在那一列按「換金鑰」，不要重新登記一次。' });
      }
      const id = uniqueId(wanted || newId('app'), S.apps.map((x) => x.id));
      a = { id, name, emoji: b.emoji || '📦', url: String(b.url || ''), token,
        fields: wantFields || [], public: false };
      const wantRepo = KF.normRepo(b.repo);
      if (wantRepo) a.repo = wantRepo;
      /* 新 App 也可以直接標公開，但一樣要過那道防線（預設是 false，必須明確送 true） */
      if (wantPublic) {
        const why = KF.publicBlockReason(a);
        if (why) return sendJson(res, 400, { ok: false, message: why });
        a.public = true;
      }
      /* 多欄位的 App：金鑰是由各格組出來的，不是直接貼一串。所以「有沒有金鑰」
       * 要等組完才算得準——不能在上面就用 b.token 是不是空的來擋。 */
      const tk0 = composeToken(a, b);
      if (tk0 !== null) a.token = tk0;
      /* 沒帶金鑰就是「還沒有金鑰」，**不擋**：多欄位的 App 正常流程就是
       * 先宣告欄位、再到「換金鑰」把各格填上。危險的是「沿用別的 App 的金鑰」，
       * 不是「暫時沒有金鑰」——後者只是還不能解密，畫面會顯示「沒有金鑰」，
       * buildKeyring() 也不會為它產出任何密文。 */
      /* 啟動頁磚塊的順序：新的排在最後面（順序固定，不會自己跳） */
      a.order = S.apps.length;
      S.apps.push(a);
      /* 他要管的只有成員：新 App 直接給所有現有使用者，要收再到「誰可以用」取消。
       * ⚠️ 「只放連結」的 App 例外：它沒有金鑰可以解，掛在成員底下只是雜訊
       *    （keyed 從 token 是不是空的推導，不另外存 linkOnly 旗標）。 */
      const wantsKey = !!a.token || (a.fields || []).length > 0 || String(b.kind || '') === 'key';
      if (wantsKey) {
        S.users.forEach((u) => {
          if (!Array.isArray(u.apps)) u.apps = [];
          if (u.apps.indexOf(id) < 0) u.apps.push(id);
        });
      }
    }
    /* 存了新金鑰就**當場去問一次到期日**（規格：必測）。測不到不擋存檔。 */
    if (isNew && a.token) { try { await checkAppKey(a); } catch (e) { /* 測不到就算了 */ } }
    await commitChanges(isNew ? ('登記了 App「' + name + '」') : ('改了 App「' + name + '」'));
    return sendJson(res, 200, { ok: true, appId: a.id, state: viewState() });
  }

  mt = p.match(/^\/apps\/([^/]+)\/token$/);
  if (mt && m === 'POST') {
    const a = findApp(decodeURIComponent(mt[1]));
    if (!a) return sendJson(res, 404, { ok: false, message: '找不到這個 App' });
    const b = await readJson(req);
    const fields = KF.normFields(a.fields);
    if (fields.length) {
      /* 多欄位：**只進不出**。前端只送「他這次真的打了字的那幾格」與「他按了清掉的那幾格」，
       * 現在的值由 server 自己從 token 拆出來合併——明文一步都不離開這支程式。 */
      const cur = KF.parse(fields, a.token);
      const next = KF.merge(fields, cur.values, b.values || {}, b.clear || []);
      const v = KF.validate(fields, next);
      if (!v.ok) return sendJson(res, 400, { ok: false, message: v.message });
      const nextToken = KF.compose(fields, next, cur.extra);
      /* 公開的 App 換金鑰時再擋一次：他可能是在公開之後才貼了一把 PAT 進來 */
      if (a.public) {
        const why = KF.publicBlockReason({ token: nextToken, fields });
        if (why) return sendJson(res, 400, { ok: false, message: why + '（這個 App 目前是公開的，要放這種金鑰請先把公開關掉）' });
      }
      a.token = nextToken;
    } else {
      const token = String(b.token || '').trim();
      if (!token) return sendJson(res, 400, { ok: false, message: '先貼上新的金鑰' });
      if (a.public) {
        const why = KF.publicBlockReason({ token, fields });
        if (why) return sendJson(res, 400, { ok: false, message: why + '（這個 App 目前是公開的，要放這種金鑰請先把公開關掉）' });
      }
      a.token = token;
    }
    /* 換了金鑰＝到期日一定不一樣了，當場重測一次（規格 4-2 的①） */
    let checked = '';
    try { checked = (await checkAppKey(a)).message; } catch (e) { checked = ''; }
    await commitChanges('換了「' + a.name + '」的金鑰');
    return sendJson(res, 200, { ok: true, checked, state: viewState() });
  }

  /* 欄位宣告：把一個 App 從「一格」改成「幾格」（或改回去）。
   * ⭐ **原地遷移**：他以前手打的那串 JSON，在 server 這邊當場拆成各格、正規化之後存回去
   *    （少宣告的鍵補空字串、宣告以外的鍵原樣留著）。明文一步都不離開這支程式。
   * ⚠️ **拆不開的時候一個位元組都不動**：那串字原樣留著（畫面上會標「格式待確認」、
   *    整串當成第一格顯示），等他自己送新值進來再改。
   *    絕對不要在這裡把拆不開的東西改寫成 JSON —— 那等於在他還沒確認之前就動了他的資料，
   *    而且他按「改回一格」也救不回原本那串。 */
  /* 公開模式開關。⛔ 預設一律加密，公開必須明確送 public:true 進來。 */
  mt = p.match(/^\/apps\/([^/]+)\/public$/);
  if (mt && m === 'POST') {
    const a = findApp(decodeURIComponent(mt[1]));
    if (!a) return sendJson(res, 404, { ok: false, message: '找不到這個 App' });
    const b = await readJson(req);
    const want = !!b.public;
    if (want) {
      /* 硬防線：不是只靠前端的警告框。值長得像 GitHub token 就直接擋，
       * 因為公開＝明文放進公開 repo，那種東西外流是災難（有 repo 寫入權）。 */
      const why = KF.publicBlockReason(a);
      if (why) return sendJson(res, 400, { ok: false, message: why });
    }
    a.public = want;
    await commitChanges(want ? ('把「' + a.name + '」設成公開模式') : ('關掉「' + a.name + '」的公開模式'));
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  /* 開場外觀（App 啟動時中央那一塊：符號／名字／標語／三個顏色）。
   * ⭐ 純顯示、公開明文，跟金鑰與加密流程完全無關 —— 跟 public／plain 同一層級。
   * 空的項目不會被存起來（見 KF.normSplash）；整組都空就把 splash 這個鍵拿掉。 */
  mt = p.match(/^\/apps\/([^/]+)\/splash$/);
  if (mt && m === 'POST') {
    const a = findApp(decodeURIComponent(mt[1]));
    if (!a) return sendJson(res, 404, { ok: false, message: '找不到這個 App' });
    const b = await readJson(req);
    const sp = KF.normSplash(b.splash);
    /* 自由文字會原樣躺在公開 repo 裡：這裡守一次，別讓金鑰從這條路漏出去 */
    const why = KF.splashBlockReason(sp);
    if (why) return sendJson(res, 400, { ok: false, message: why });
    if (sp) a.splash = sp; else delete a.splash;
    await commitChanges('改了「' + a.name + '」的開場外觀');
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  mt = p.match(/^\/apps\/([^/]+)\/fields$/);
  if (mt && m === 'POST') {
    const a = findApp(decodeURIComponent(mt[1]));
    if (!a) return sendJson(res, 404, { ok: false, message: '找不到這個 App' });
    const b = await readJson(req);
    const fields = KF.normFields(b.fields);
    const bad = badHint(fields);
    if (bad) return sendJson(res, 400, { ok: false, message: bad });
    a.fields = fields;
    let migrated = false;
    if (fields.length && a.token) {
      const r = KF.parse(fields, a.token);
      if (r.ok) {
        const next = KF.compose(fields, r.values, r.extra);
        migrated = next !== a.token;
        a.token = next;
      }
    }
    await commitChanges('設定了「' + a.name + '」的金鑰欄位');
    return sendJson(res, 200, { ok: true, migrated, state: viewState() });
  }

  /* 金鑰到期偵測：拿**這個 App 自己的那把 token** 去打**它自己的 repo**。
   * ⛔ 回應只給算好的狀態，明文一個字都不出這支程式。 */
  mt = p.match(/^\/apps\/([^/]+)\/checkkey$/);
  if (mt && m === 'POST') {
    const a = findApp(decodeURIComponent(mt[1]));
    if (!a) return sendJson(res, 404, { ok: false, message: '找不到這個 App' });
    const r = await checkAppKey(a);
    if (r.changed) await commitChanges('重新檢查了「' + a.name + '」的金鑰到期日');
    else await saveSecrets(true);      /* 結果沒變就只更新本機的檢查時間，不產生一筆 commit */
    return sendJson(res, 200, { ok: true, message: r.message,
      key: KF.keyExpState(a.keyExp, new Date().toISOString()), state: viewState() });
  }
  /* 「重新檢查全部」：一個 App 一個請求、各用各的 token，中間任何一把失敗都不影響其他把 */
  if (p === '/apps/checkkeys' && m === 'POST') {
    const lines = [];
    let changed = false;
    for (const a of S.apps) {
      if (!a.token) continue;
      try {
        const r = await checkAppKey(a);
        changed = changed || r.changed;
        lines.push(a.name + '：' + r.message);
      } catch (e) {
        lines.push(a.name + '：這次測不到（' + firstLine(e && e.message) + '）');
      }
    }
    if (changed) await commitChanges('重新檢查了所有金鑰的到期日');
    else await saveSecrets(true);
    return sendJson(res, 200, { ok: true, lines, state: viewState() });
  }
  /* 手動填到期日（備援）。⚠️ 自動測得到的時候會蓋掉它並標回 auto —— 自動比人記得準。 */
  mt = p.match(/^\/apps\/([^/]+)\/keyexp$/);
  if (mt && m === 'POST') {
    const a = findApp(decodeURIComponent(mt[1]));
    if (!a) return sendJson(res, 404, { ok: false, message: '找不到這個 App' });
    const b = await readJson(req);
    const d = KF.normDate(b.expiresAt);
    if (b.expiresAt && !d) {
      return sendJson(res, 400, { ok: false, message: '日期要寫成 2026-12-02 這種樣子' });
    }
    if (d) a.keyExp = { expiresAt: d, source: 'manual', checkedAt: new Date().toISOString(), state: 'ok' };
    else delete a.keyExp;
    await commitChanges(d ? ('把「' + a.name + '」的到期日填成 ' + d) : ('清掉「' + a.name + '」的到期日'));
    return sendJson(res, 200, { ok: true, state: viewState() });
  }
  /* 啟動頁磚塊的順序（固定順序是 Benson 拍板的，不做「最近更新排前面」） */
  mt = p.match(/^\/apps\/([^/]+)\/move$/);
  if (mt && m === 'POST') {
    const id = decodeURIComponent(mt[1]);
    const b = await readJson(req);
    const dir = String(b.dir || '') === 'up' ? -1 : 1;
    const ordered = S.apps.slice().sort((x, y) => ordOf(x) - ordOf(y));
    const i = ordered.findIndex((x) => x.id === id);
    if (i < 0) return sendJson(res, 404, { ok: false, message: '找不到這個 App' });
    const j = i + dir;
    if (j < 0 || j >= ordered.length) return sendJson(res, 200, { ok: true, state: viewState() });
    const tmp = ordered[i]; ordered[i] = ordered[j]; ordered[j] = tmp;
    ordered.forEach((x, k) => { x.order = k; });
    await commitChanges('把「' + (findApp(id) || {}).name + '」在啟動頁的位置' + (dir < 0 ? '往前挪' : '往後挪'));
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
    await commitChanges('改了「' + findApp(appId).name + '」可以給誰用');
    return sendJson(res, 200, { ok: true, state: viewState() });
  }

  mt = p.match(/^\/apps\/([^/]+)$/);
  if (mt && m === 'DELETE') {
    const id = decodeURIComponent(mt[1]);
    const gone = findApp(id);
    S.apps = S.apps.filter((a) => a.id !== id);
    S.users.forEach((u) => { u.apps = (u.apps || []).filter((x) => x !== id); });
    await commitChanges('把 App「' + ((gone && gone.name) || id) + '」拿掉');
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
  // 加密真本。跟 keyring.json 一樣是「本來就要公開」的檔，本機開放是為了先在電腦上試手機後台
  if (rel === '/vault.json') {
    return streamFile(res, VAULT_FILE, { 'Access-Control-Allow-Origin': '*' });
  }
  // 啟動頁的公開清單（正式版在 Pages 的根目錄；本機開放是為了先在電腦上把啟動頁跑一遍）
  if (rel === '/apps.json' || rel === '/launch/apps.json') {
    return streamFile(res, APPS_FILE, { 'Access-Control-Allow-Origin': '*' });
  }
  // 啟動頁本人：正式版是 https://xd1104.github.io/keyring/（repo 根目錄的 index.html）。
  // 本機後台自己佔著 /，所以在這裡開一條 /launch/ 給它預覽。
  if (rel === '/launch' || rel === '/launch/') {
    return streamFile(res, LAUNCH_INDEX);
  }
  if (rel.indexOf('/launch/') === 0) {
    const lf = path.join(LAUNCH_DIR, path.normalize(rel.slice(8)).replace(/^([/\\])+/, ''));
    if (!lf.startsWith(LAUNCH_DIR)) { res.writeHead(400); return res.end('bad path'); }
    return streamFile(res, lf);
  }
  // 手機後台：正式上線是 GitHub Pages 的 /web/，這裡讓它在電腦上也能先跑一遍
  if (rel === '/web' || rel === '/web/') rel = '/web/index.html';
  if (rel.indexOf('/web/') === 0) {
    const wf = path.join(WEB_DIR, path.normalize(rel.slice(5)).replace(/^([/\\])+/, ''));
    if (!wf.startsWith(WEB_DIR)) { res.writeHead(400); return res.end('bad path'); }
    return streamFile(res, wf);
  }
  // 前端解鎖模組的正本放這裡，各 App 複製過去用
  if (rel === '/keyring-unlock.js') {
    return streamFile(res, path.join(ROOT, 'client', 'keyring-unlock.js'), { 'Access-Control-Allow-Origin': '*' });
  }
  // 多欄位金鑰的共用邏輯：兩個後台都載它。
  // 手機後台在 GitHub Pages 上是用 ../client/keyring-fields.js 抓（repo 根目錄就在那），
  // 本機預覽時 /web/ 是從 WEB_DIR 服務的，所以這裡把兩種路徑都接住。
  if (rel === '/keyring-fields.js' || rel === '/client/keyring-fields.js') {
    return streamFile(res, path.join(ROOT, 'client', 'keyring-fields.js'), { 'Access-Control-Allow-Origin': '*' });
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
loadVaultKey();
/* ⚠️ 一定要綁 127.0.0.1，不能只給 PORT（那等於 0.0.0.0＝所有網路介面）。
 * 這個後台**沒有密碼**（設計前提是「只有這台電腦」），但它可以新增使用者、
 * 換金鑰、觸發發布。綁全介面的話，同一個 Wi-Fi 上的任何人打
 * http://<這台電腦的IP>:4620 就進得來 —— 咖啡廳、公司網路都算。
 * （2026-08-28 發現：tool-manager 從一開始就綁 127.0.0.1，這裡漏了。）
 * 手機後台走的是 GitHub Pages 上的 vault.json，不是連這個埠，所以不受影響。 */
server.listen(PORT, '127.0.0.1', async () => {
  console.log('Keyring admin running at http://localhost:' + PORT + '（只接受本機連線）');
  console.log('Secrets (local only): ' + SECRETS_FILE);
  console.log('Public keyring:       ' + KEYRING_FILE);
  if (V) console.log('Mobile admin vault:   ' + VAULT_FILE + '（配對碼 ' + V.pairing + '）');
  await diagnose();          // 第一個畫面就要說實話
  if (!pubState.ok) console.log('[publish] ' + pubState.message);
  /* 開機先跟手機那邊對一次時間戳，否則第一個畫面可能是舊的 */
  await refreshFromRemote();
});
