# 🔑 鑰匙圈（keyring）

一人一組密碼，任何裝置輸一次就能編輯我做的那些 GitHub Pages App（旅途手帳、食譜本…）。
不用再把一長串 GitHub PAT 貼來貼去。

> **這個 repo 的首頁（<https://xd1104.github.io/keyring/>）現在是「啟動頁」，不是這份 README。**
> 根目錄多了 `index.html` ＋ 一個空的 `.nojekyll`，Pages 就直接服務靜態檔、不再用 Jekyll 把 README
> 渲染成 landing page（那頁本來也沒人看）。README 從 GitHub 的 repo 頁面照樣看得到。
> 啟動頁是**免密碼**的：見下面「啟動頁」那一節。

## 為什麼這樣做

Pages 是純靜態、**沒有伺服器可以驗密碼**。所以：

1. 後台（電腦上的 `server.js`，或手機上的 `web/`）把每個 App 的 PAT **用每個人的密碼各加密一份**。
2. 密文寫進 `keyring.json`，自動 push 到這個公開 repo。
3. App 前端抓 `keyring.json`，使用者選自己、輸密碼，**在瀏覽器裡**用 WebCrypto 解開，
   把解出來的金鑰寫進那個 App 原本就在用的 localStorage key。

密碼錯的唯一症狀就是「解不開」（AES-GCM 驗證失敗），所以檔案裡**不需要、也沒有**密碼或密碼 hash。

## 六個檔案（別搞混）

| 檔案 | 內容 | 會不會上傳 |
|---|---|---|
| `secrets.json` | **明文 PAT** ＋ 每個人的派生金鑰 | ❌ 在 `.gitignore` 裡，永遠只在這台電腦 |
| `keyring.json` | 只有 salt／iv／密文 | ✅ 這就是要發布的東西 |
| `vault.json` | 整份 `secrets.json` 加密後的樣子（給手機後台用） | ✅ 是密文，但要有管理密碼＋配對碼才解得開 |
| `vault.key` | 解 `vault.json` 的金鑰＋這台電腦的配對碼 | ❌ 在 `.gitignore` 裡，跟 `secrets.json` 同一級 |
| `apps.json` | 啟動頁的清單：名字／圖示／網址／repo／順序／有沒有金鑰／到期日 | ✅ 公開，**一個祕密都沒有**（白名單產生，見「啟動頁」那一節） |
| `tools.local.json` | 「🧰 工具」分頁的本機工具清單（路徑／啟動指令／port） | ❌ 在 `.gitignore` 裡（見「工具」那一節） |

刻意存「派生金鑰」而不是密碼：後台真的看不到任何人的密碼，但又能在「多給某人一個 App」時
直接用他的金鑰加密新條目，不必再問他一次密碼。**換密碼＝重新派生金鑰＋把所有 PAT 重加密。**

## 第一次：怎麼把 repo 接起來

剛裝好的時候，這個資料夾**還沒跟 GitHub 接上**，所以後台最上面會是琥珀色的
「存好了，但還沒送到 GitHub」。**這是正常的，你存的東西都在這台電腦上，不會不見**，
只是別的裝置還拿不到。接起來只要兩步：

1. 到 github.com 開一個新的 repo，名字叫 **`keyring`**，選 **Public**
   （不用勾 README、不用選 .gitignore——這邊都已經有了）。
2. 回到後台，按琥珀色那條裡的 **「🔗 幫我接起來」**。
   它會在這個資料夾 `git init`、把 `origin` 指到 `https://github.com/xd1104/keyring.git`，然後送出去。

成功之後那條會變成綠色的「✓ 存檔就自動發布了」，以後每次存檔都會自動 push，不用再管它。

會遇到的另外兩種狀況，後台都會直接寫在畫面上：
- **GitHub 說找不到 repo** → repo 還沒開好，或名字/帳號打錯了。
- **GitHub 不讓這台電腦寫入** → 登入資訊過期。在一般的命令提示字元跑一次 `git push origin HEAD`
  照指示登入（或用 GitHub Desktop 登入 xd1104），再回來按「再試一次」。

> 不管哪一種失敗，`secrets.json` 與 `keyring.json` 都**已經寫進硬碟了**；發布只是「送出去」這一步沒成功。

## 怎麼開

**桌面 App（推薦）**：雙擊桌面的「🔑 鑰匙圈」。它會先確認伺服器活著（沒有就開起來），
再**自己開一個視窗**（pywebview，底層是 Windows 11 內建的 WebView2）；視窗關掉就整組收乾淨。
工作列顯示的是鑰匙圖示、不是 Edge 或 python 的。

也可以雙擊 `start.bat`。網址 <http://localhost:4620>。

> 以前是從 tool-manager 面板（port 4900）→「AI 工具」→ 鑰匙圈開的。
> **2026-09-01 起反過來了**：tool-manager 整支併進這裡的「🧰 工具」分頁，那支面板退役。

### 桌面 App 的三個細節（別誤改）

- **`server.js` 仍然是零執行期依賴**。多出來的 `.venv`（pywebview ＋ pythonnet）
  只給 `keyring-app.pyw` 那支「開視窗」用，伺服器本身沒有變。
- **`.venv/` 一定要留在 `.gitignore` 裡**：後台「存檔即發布」跑的是 `git add -A` ＋ push 到
  **公開** repo，沒忽略的話那幾十 MB 會被推上去。
- **不要改用 Edge 的 `--app` 開視窗**：那樣視窗的擁有者是 Edge，工作列會顯示 Edge 的圖示
  （安裝成 PWA 也一樣），而且關窗時機測不準。這是 trade-log 的早盤儀表板踩過整串才換掉的，
  `keyring-app.pyw` 的註解裡有完整原因。
- **刻意沒有看門狗**。早盤儀表板需要它是因為永豐 SDK 斷線會把行程帶走；
  這裡的 server 沒有外部 SDK，沒那個故障模式。

圖示是 `make-icon.py` 產的（純標準函式庫，沒有 Pillow 也能跑）：
`.venv\Scripts\python.exe make-icon.py`。**16px 以下是另外畫一張**，不是把大圖縮小——
等比縮下去會糊成一團暗色斑點（第一版實際踩過）。
手機後台在 <https://xd1104.github.io/keyring/web/>（本機也開得起來：<http://localhost:4620/web/>，
拿來在電腦上先試一遍）。

- 存檔就自動發布（git commit + push），沒有草稿狀態、沒有發布按鈕。
- 發布失敗（沒網路、repo 沒開）只會在上面那條顯示原因，**本機一定已經存好了**。
- 安全閘門：`secrets.json` 或 `vault.key` 若不在 `.gitignore` 裡，整個發布會直接中止。

## 手機後台（不用開電腦也能管）

`web/` 是一份純靜態的後台，放在 GitHub Pages 上，手機開網頁就能加人、換密碼、貼新金鑰、
登記新 App —— 跟本機後台做得到的事一模一樣。它沒有伺服器，做法跟 `keyring-unlock.js` 同一套：

1. 本機後台把整份 `secrets.json`（明文 PAT ＋ 每個人的派生金鑰 ＋ 一把寫回 repo 用的 GitHub 金鑰）
   加密成 `vault.json` 發布出去。
2. 手機抓 `vault.json`，**在瀏覽器裡**用「管理密碼 ＋ 裝置配對碼」解開。
3. 改完重新加密，用 vault 裡那把 GitHub 金鑰直接呼叫 GitHub API，
   把 `vault.json` 與 `keyring.json` **包成同一個 commit** 寫回去。

明文一秒都沒離開那台裝置，中間沒有任何後端看得到它。

### 為什麼要「配對碼」

`vault.json` 是公開檔案。只靠一組密碼的話，「猜到密碼 ＝ 拿到所有 App 的 PAT」。
所以解密金鑰是 `PBKDF2(管理密碼 + "\n" + 配對碼)`：配對碼是本機後台產的 80-bit 隨機碼，
**只住在裝置裡**（電腦的 `vault.key`、手機的 `localStorage`），不進任何公開檔案。
整份 `vault.json` 被抓走、密碼又剛好被猜中，沒有配對碼還是解不開。

手機第一次要貼一次配對碼（後台有「複製連結」，開帶 `#pair=` 的連結會自動收下），之後只要輸密碼。

### 怎麼開起來

1. **本機後台** →「📱 手機後台」→ 設一組管理密碼（至少 8 個字，它等於所有 App 的金鑰）。
2. 同一頁「手機那邊寫回 GitHub 用的金鑰」→ 貼一把 fine-grained PAT：
   Repository access 只勾 `keyring`，權限只給 **Contents: Read and write**。
   沒貼的話手機進得去、但存不回來。
3. repo 的 **Settings → Pages → Deploy from a branch → `main` / `(root)`**（只要按這一次）。
4. 手機開 <https://xd1104.github.io/keyring/web/>，貼配對碼、輸管理密碼。

> 這把寫回用的 PAT 跟各 App 那些「一把只授權自己那一個 repo」的金鑰是分開的兩件事：
> 它只加密進 `vault.json`，不會進 `keyring.json`，也不會跑到任何 App 的瀏覽器裡。

### 兩邊都能改，`vault.json` 是唯一真本

本機後台**每次動手之前**都會先 `git fetch` 一次，比對遠端 `vault.json` 的 `updatedAt`：
遠端比較新就整份接手過來（`merge -X theirs`，再從 vault 重建 `secrets.json`），否則維持本機。
手機那邊反過來：存檔前先確認 GitHub 上的 commit 沒動過，動過就整份重新載入、請你再做一次，
而且推的時候 `force:false` —— 寧可整筆失敗，也不要蓋掉對方剛存的東西。

用時間戳而不是逐檔合併是刻意的：這三個檔案是同一份資料的三種樣子，各合各的只會合出壞資料。

換管理密碼／換配對碼都在本機後台那一頁；換了之後每支手機要重新輸密碼（換配對碼才需要重貼配對碼）。

## 資料格式（`keyring.json`）

```jsonc
{
  "version": 1,
  "updatedAt": "ISO",
  "apps": [{ "id": "travel-book", "name": "旅途手帳", "emoji": "🧳" }],
  "users": [{
    "id": "<slug>", "name": "Benson", "emoji": "🧔", "theme": "sunset",
    "kdf": { "algo": "PBKDF2-SHA256", "iter": 600000, "salt": "<base64>" },
    "apps": { "travel-book": { "iv": "<base64>", "cipher": "<base64>" } }
  }]
}
```

- 一個人一個 salt（一組密碼派生一把金鑰，用來加密他所有 App 的 PAT）；每個 App 條目各自的 iv。
- **公開檔裡沒有「欄位宣告」**：一個 App 要幾把金鑰是**後台自己的事**（存在 `secrets.json`／`vault.json`），
  公開的 `keyring.json` 永遠只有 `{id,name,emoji}` ＋ 密文。見下面「一個 App 要兩把金鑰」。
- **`id` 一律是 ASCII**（使用者 `u-<ts36>`、App 用 Benson 填的代號），顯示用的原文放 `name`。
  中文／日韓文當 id 會在不同系統之間被正規化成不同字串而分裂成兩筆——travel-book 吃過這個虧。
- `cipher` ＝ AES-GCM 密文 ‖ 16 bytes authTag（WebCrypto 的格式，Node 端要自己接上去）。
- 刻意用 JSON 不用 md：這是機器讀寫的檔，沒有人要手改，也就不必像 travel-book 那樣維護兩套 parser。

### `vault.json`

```jsonc
{
  "version": 1,
  "updatedAt": "ISO",                                     // 兩邊對時就是看這一行
  "kdf": { "algo": "PBKDF2-SHA256", "iter": 600000, "salt": "<base64>" },
  "iv": "<base64>",
  "cipher": "<base64>"    // AES-GCM(整份 secrets.json 的 JSON) ‖ 16 bytes authTag
}
```

解開之後長這樣（＝`secrets.json` ＋ 一個 `github` 區塊）：

```jsonc
{
  "version": 1, "updatedAt": "ISO",
  "apps":  [{ "id": "travel-book", "name": "旅途手帳", "emoji": "🧳", "url": "", "token": "<明文 PAT>" }],
  "users": [{ "id": "u-…", "name": "…", "emoji": "…", "theme": "…",
              "salt": "<base64>", "dk": "<base64 派生金鑰>", "apps": ["travel-book"] }],
  "github": { "owner": "xd1104", "repo": "keyring", "branch": "main", "token": "<寫回用的 PAT>" }
}
```

加解密參數（PBKDF2-SHA256 600000 ＋ AES-GCM 256）在 `server.js`、`client/keyring-unlock.js`、
`web/admin.js` **三個地方**各有一份實作，改要三邊一起改。

## 一個 App 要兩把金鑰（多欄位）

有些 App 不只要一把鑰匙 —— 例如「好雷嗎」要 **TMDB ＋ OMDb** 兩把。
以前的做法是叫 Benson 在那一格手打 `{"tmdb":"…","omdb":"…"}` 一整行；現在後台**直接給他兩格**。

**做法（刻意選最小風險的那一種）**：
每個 App 可以宣告自己要哪幾格（`apps[].fields`），**後台的 UI 幫他把幾格組成那一串 JSON**。

- **儲存與加密格式一個位元組都沒變**：加密的還是「一個 App 一串不透明字串」。
- 所以 **`keyring.json` 的結構、`client/keyring-unlock.js` 的解密流程、三個 App 的前端都不用動**。
- **沒有宣告 `fields` 的 App（旅途手帳、食譜本）行為與畫面完全不變**（`tools/check-fields.js` 的 B 組
  會拿改動前的 `server.js` 產一次 `keyring.json` 逐項比對，證明這件事）。

```jsonc
// secrets.json / vault.json 裡的 apps[] （公開的 keyring.json 沒有這一段）
{ "id": "movie-library", "name": "好雷嗎", "emoji": "🎬", "token": "{\"tmdb\":\"…\",\"omdb\":\"…\"}",
  "fields": [
    { "key": "tmdb", "label": "TMDB 金鑰", "hint": "API Key (v3 auth)", "optional": false },
    { "key": "omdb", "label": "OMDb 金鑰", "hint": "沒有就留空",        "optional": true  }
  ] }
```

**後台怎麼用**（兩個後台一樣）：登記 App 時按「＋ 加一格」，或直接按現成的
「套用『好雷嗎（TMDB ＋ OMDb）』」；已經登記過的 App 用那一列的 **「金鑰欄位」**（手機是 ⋯ →「🧩 金鑰欄位」）。
設好之後按「換金鑰」就會看到兩格。

- **按下「存起來」的時候，後台會當場把原本那串拆進各格**（少宣告的鍵補空字串、
  宣告以外的鍵原樣留著）。**拆不開的話一個位元組都不動**，只標成「格式待確認」，
  等他自己填新的——**永遠不會靜靜清掉他貼過的東西**。
- **畫面上永遠只看得到遮罩**（`tmdb TMDB••••••••33 · omdb ••••••••`）。
  後台的 HTTP API **從來不吐明文金鑰**，即使 server 自己手上有——這是這個系統刻意的不變式，
  `tools/check-fields.js` 的 F 組會掃描所有回應把它釘死。
  所以換金鑰是「**留空＝不改這一格**」：只送新值上去，原值由後台自己合併。
- 多欄位的遮罩比 GitHub PAT 那套更狠（最多前 4 後 2，8 碼以下整條遮掉）：
  TMDB／OMDb 的金鑰**整串都是祕密**，不像 `github_pat_11AB…` 前面十幾碼是公開前綴。
- 他手機上如果還快取著**舊版**的 `web/admin.js`，從手機存檔**不會**把欄位宣告洗掉
  （舊版送上來的資料沒有 `fields` 這個鍵＝「這版不認得」，後台會保留原本的宣告）。
  不過還是建議合併之後在手機上把那頁重新整理一次。
- 欄位代號只收英文小寫（`tmdb`、`omdb`），跟 App id 同一條鐵律。
- 那個 App 的前端自己負責把那串 JSON 拆成兩把（好雷嗎已經這樣做了）。

## 公開模式：打開網址就能用，沒有登入畫面

有些 App 用的根本不是憑證，是**免費查詢金鑰**（電影評分的 TMDB／OMDb）。
那種 App 不該有登入畫面，所以可以把它標成 **公開**：值**不加密**，直接以明文放進公開的
`keyring.json`，**不綁任何使用者、不需要密碼**。

```jsonc
// keyring.json 的 apps[]（公開的那一筆才有 public / plain）
{ "id": "movie-library", "name": "電影評分", "emoji": "🎬",
  "public": true,
  "plain": "{\"tmdb\":\"0f7c…\",\"omdb\":\"9ab1…\"}" }
```

- 欄位刻意叫 **`plain`**（跟 `iv`／`cipher` 明確分開），讀取端一眼分得出來這不是密文。
- 公開的 App **不會**再出現在 `users[].apps` 裡（同一個值有兩個來源只會讓讀取端要猜哪個算數）。
- 前端不用改：`Keyring.init()` 發現這個 App 是公開的就直接把值交給宿主，
  **不彈解鎖層、不畫身分藥丸**。宿主可以問 `Keyring.isPublic()` 與 `Keyring.whenReady()`。
- 值會在裝置上快取一份，**下次沒網路也打得開**；後台換了值就自動換過去。

### 怎麼設（後台按一下就好）

那一列的 **「公開」** → 「我知道會被看到，設成公開」。
**不用重新輸入金鑰**：後台自己把現有的值搬進公開區塊。手機後台是 ⋯ →「🌐 公開模式」。

### ⛔ 代價與防線

**公開＝任何人都拿得到那組金鑰。** TMDB／OMDb 最壞是額度被用掉，重新產一組就好；
**GitHub token 絕對不行**（有 repo 寫入權，外流是災難）。所以：

1. **預設一律加密**，公開必須明確按下去
2. 按下去之前有白話警告（`KF.PUBLIC_WARNING`）
3. **值長得像 GitHub token（`github_pat_` / `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_`）就在 server 端擋**，
   不是只靠前端；換金鑰時也擋（他可能是公開之後才貼 PAT 進來的）
4. **產生 `keyring.json` 的那一刻再擋一次**：發現值變成 PAT 就**降級成加密**（fail-safe，
   祕密留在密文裡），後台畫面上會顯示「勾了公開但被擋下來」，不是靜靜失效
5. 紅線：`tools/check-fields.js` 的 **H12** 斷言 `keyring.json` 裡沒有任何 GitHub token 形狀的明文，
   **I 組**故意把防線拿掉證明那條紅線會紅

## 啟動頁：<https://xd1104.github.io/keyring/>（免密碼那一頁）

手機主畫面上的那一顆。**打開就是一排 App，點一下就開**，不用密碼、不用解鎖。
它讀的是 repo 根目錄的 `apps.json` —— 這個 repo 唯一新增的公開檔，**一個祕密都沒有**：
只有名字、圖示、網址、GitHub repo、順序、有沒有金鑰、以及那把金鑰哪天到期。

| 檔 | 做什麼 |
|---|---|
| `index.html` ＋ `launch/` | 啟動頁本人（class 前綴 `lc-`，跟後台的 `ad-`／解鎖的 `kr-` 不相撞） |
| `apps.json` | 公開清單。**只由 `client/keyring-fields.js` 的 `buildApps()` 產**（白名單） |
| `sw.js` | 只快取啟動頁那四個檔案，讓它斷網也打得開；其他請求（含 `/web/`）完全不插手 |
| `.nojekyll` | 讓 Pages 直接服務靜態檔（代價：README 那張 landing page 不再渲染） |

- **順序固定**（後台可上移下移），刻意不做「最近更新排前面」——位置每天跳，肌肉記憶就沒了。
- **磚塊是真的 `<a target="_blank">`**：長按可以「在新分頁開」，離線也點得開。
- `apps.json` 走 cache-first：先用上次存下來的那份畫出來，再背景抓新的。**離線時磚塊照樣全部可點。**
- 各 App 的「更新於 X」用一個**未認證**的 GitHub 請求就拿得到全部
  （`/users/xd1104/repos?sort=pushed`），快取 30 分鐘；拿不到就顯示「—」，
  footer 誠實寫「更新時間這次沒拿到」，**清單照常**。
- 本機預覽：<http://localhost:4620/launch/>（正式版在 Pages 的根目錄，本機後台自己佔著 `/`）。

> ⚠️ `name`／`emoji`／`url`／`repo` 是自由文字，會原樣公開。產生 `apps.json` 時每一欄都會過一次
> `KF.secretishDeep()`，中了就**整份產生失敗**並在後台顯示原因（不靜靜降級——這裡沒有安全的替代值可以倒）。
> **「夾在句子裡」也算**：`我的金鑰是 <token> 別外流`、`token=<token>`、`?token=<token>`、
> 多欄位的整串 `{"tmdb":…}` 都擋得下來 —— 舊版只認「整格剛好等於一把金鑰」，而前後帶字才是最自然的貼法。
> 唯一的例外是 `brain-boosting-games` 那種全小寫的代號（`KF.looksLikeSlug()`），
> 不然自己的防線會擋掉一個正常的登記。

### 金鑰到期提醒

拿**那個 App 自己的那把 token** 打**它自己的 repo**（`GET /repos/{repo}`），讀回應標頭
`github-authentication-token-expiration`，一次就同時知道「哪天到期」與「這把還有沒有效」。

| 回應 | 判定 |
|---|---|
| 2xx ＋ 有標頭 | `ok`（到期日就是標頭上那一天） |
| 2xx ＋ 沒標頭 | `none`（這把不會過期） |
| 401 | `expired` |
| 403／404／連不上 | 維持上一次的結果；沒有上一次就是 `unknown`「還沒檢查過」 |

- ⛔ **不可以拿鑰匙圈那把（或別的 App 那把）去測**：那等於讓金鑰跨 App 流動。
- ⛔ 明文 token 不進任何 HTTP 回應、不進 `apps.json`：電腦端在 server 裡打完只回 `{expiresAt,state}`；
  手機端在瀏覽器裡用它自己解出來的那把打完就丟。
- 什麼時候測：① 存了新金鑰的當下（必測）；② 手機後台每次解鎖後背景測一輪；③ 後台那顆「重新檢查全部」。
  **不做排程**（沒有安全的地方放全部的金鑰）。**結果沒變就不會產生 commit**。
- 門檻兩段：**≤30 天**後台卡片的 chip 轉琥珀；**≤14 天**啟動頁才跳提醒帶（別吵他一個月）。
  已過期是紅色。**永遠不擋他開 App。**
- 倒數是啟動頁**本機算的**（到期日是固定的未來日期），所以快照過期不會讓提醒失效。
- 手動填只是備援（`source:"manual"`）；自動測到就覆蓋它並標回 `auto`——自動比人記得準。
- 「測不到」有自己的樣子（灰 chip「還沒檢查過」），**不會被畫成沒事**。

### 近況（誰改了鑰匙圈）

git 的 author 沒有用：電腦端一律是 `LAPTOP-…\USER`，手機端是用鑰匙圈那把 PAT 走 GitHub API 送的，
黏跟肚都是 `xd1104`。所以人名寫進 **commit message** 的 trailer，兩端共用一份格式
（`KF.commitMessage()` / `KF.parseCommitMessage()`）：

```
鑰匙圈：換了「食譜本」的金鑰

by: 肚 · 手機後台
```

- 第一行是**人話摘要**（取代舊的 `keyring: update <ISO>`）。呼叫端最清楚自己剛做了什麼，所以由它給；
  沒給才用 `keyring.json` 的結構差異推。**密文不能拿來 diff**（IV 是隨機的，每次存檔都會變）。
- 電腦後台沒有登入身分 ⇒ `by: · 電腦後台`（誠實留白，不編一個名字）。
  手機後台在設定裡有「🙋 這台是誰在用」，只存在那支手機的 localStorage，不進任何公開檔。
- 資料來源：電腦端 `GET /api/history`（`git log`）、手機端 `GET /repos/…/commits?path=keyring.json`。
  兩邊都**只解析 message**，畫面組法一模一樣。
- **誠實條款**：存檔跑的是 `git add -A`，一筆 commit 可能夾帶別的檔案，
  所以電腦端會回 `otherFiles`，畫面照實寫「這次同時改到 N 個其他檔案」。
- 舊 commit 沒有 trailer ⇒ 顯示「電腦後台」＋原始訊息，不留白。

### 只有連結、沒有金鑰的 App

`token` 允許是空字串＝「只放連結」（熱量、記帳本、拼圖那種）。這種 App 不產密文、
不出現在解鎖名單、也不掛在任何成員底下。**不另外存 `linkOnly` 旗標**——
`keyed` 從 `token` 是不是空的推導就好（少一個會分岔的真相來源）。

### 改完要跑

```
node tools/check-public.js      # apps.json 公開檔 15 條（含負控組，抓不到就 exit 2）
```

「掃了沒抓到」有兩種可能：**真的乾淨**，或**尺是壞的**。所以每一條紅線都配一組負控組
（故意把假 token 塞進 `name`／`emoji`／`key.expiresAt`，或多長一個 `token` 欄位），
另外還有 **E 組：同一份輸入餵給 `server.js` 與 `web/admin.js`，產出必須逐位元組相同**
（這個 repo 已經因為「同一條規則活在兩套實作裡」出過事）。


## 🧰 工具：這台電腦上的程式，在後台按一下就開

2026-09-01 把 **tool-manager**（原本自己一支面板，port 4900）整支併進後台的「🧰 工具」分頁，
那支之後退役。以後只用鑰匙圈。

| | |
|---|---|
| 在哪 | 後台 <http://localhost:4620> →「🧰 工具」 |
| 做得到 | 列出工具、啟動／停止／重啟、看它印了什麼、有網頁的直接點開 |
| 清單 | `tools.local.json`（改完按分頁上的「🔄 重新整理」就吃到，**不用重開後台**） |

### ⛔ 為什麼只有電腦端有這一頁

**啟動頁（`index.html`，跑在 GitHub Pages 上的公開靜態頁）永遠不可能啟動本機程式**，
手機後台（`web/`）也一樣——那兩邊都沒有這台電腦的 server。所以：

- **手機／啟動頁**：只放網頁型 App 的連結。**不放任何本機工具的啟動鈕**（放了也是死的）。
- **電腦端後台**：這一頁在這裡，tool-manager 做得到的它全做得到。

### 鑰匙圈自己不在清單裡

它就是面板本身——server 沒開的話你連這一頁都看不到，列一張「鑰匙圈：沒在跑」的卡片沒有意義。

### 卡片長相（2026-09-03 重畫，Benson 說「有點醜」）

搬過來的第一版是直接沿用 App 那一頁的 `.rowcard`：一排四顆長得一模一樣的按鈕，
狀態縮成一顆灰 chip 混在 port／pid 中間。看一眼分不出誰在跑。現在的規則：

- **狀態是這一頁唯一重要的東西**，所以它同時出現在三個地方：卡片左邊的色條、
  圖示底色、狀態那一行（在跑＝綠、啟動中＝黃並且會呼吸、沒在跑＝色條和圖示一起轉灰）。
- **一個狀態只留一顆主鈕**：沒在跑＝「▶ 啟動」（實心紅）；在跑＝「開啟 ↗」實心、
  重啟／停止淡底。**按不了的按鈕直接不畫**——原本那排反灰的死按鈕（尤其沒在跑時
  那顆紅色的「停止」）只會讓人以為壞了。
- **輸出收成一行淡字**（「看它印了什麼 ▾」），不再每張卡都掛一條整條寬的橫槓。
- 桌面 ≥820px 排兩欄；窄的時候自動回一欄。

class 前綴一律 `tk-`，不共用 App 那頁的 `.rowcard`／`.rc-*`——那一頁改版時不該連坐。
（先例：tool-manager 最後一筆 commit 把早盤儀表板移除，理由是「它已經有自己的桌面 App」。）
就算有人把舊的 `tools.json` 整份貼回來，`readTools()` 也會把 `id === "keyring"` 那筆濾掉。

### 為什麼清單搬進來、而且不公開

搬進來（不是去讀 `../tool-manager/tools.json`）是因為 tool-manager 要退役了：
留一條跨資料夾的相依，等那個資料夾被搬走或封存，這一頁就整個壞掉。

`tools.local.json` 在 `.gitignore` 裡，跟 `secrets.json` 同一級，兩個理由：

1. 裡面全是**這台電腦的絕對路徑與啟動指令**，對別的機器沒有意義；
2. 它有 `env` 欄位（tool-manager 的說明就明寫可以放環境變數），**遲早會被塞金鑰**。
   而後台存檔跑的是 `git add -A` ＋ push 到**公開** repo。

發布前的安全閘門（`assertSecretsSafe`）除了 `secrets.json`／`vault.key`，
現在也會確認 `tools.local.json` 有被忽略；沒有就**整個發布中止**。

### 一筆工具長這樣

```jsonc
{
  "id": "recipe-book",              // 唯一英文 id
  "name": "食譜本", "emoji": "🍳",
  "description": "一句話說明",
  "category": "作品",                // 分組標題（目前：作品／AI 工具）
  "cwd": "C:\\Users\\USER\\Desktop\\Claude Work\\recipe-book",
  "command": "node server.js",
  "port": 3517,                     // 沒有就 null
  "url": "http://localhost:3517",   // 沒有就 null
  "autostart": false,               // 保留欄位
  "processMatch": "recipe-book",    // 偵測「不是我開的但已經在跑」：比對程序指令列的子字串
  "env": { "PYTHONIOENCODING": "utf-8" }   // 可選
}
```

### 那些已經踩過的雷（照抄，別重寫）

- **Windows 一定要 `taskkill /pid <p> /t /f`**：`npm run dev` 那種是
  `cmd → npm → node → electron` 一長串，只殺最上面那個會留一堆孤兒。
  （實測：議題儀表板真實深度是 `cmd → python → python`，三層。）
- **程序掃描（`Get-CimInstance`）一次要一秒** → 配 5 秒 TTL 快取，掃描失敗時**沿用舊快取**
  （不要謊報成「沒在跑」）。
- **比對 `processMatch` 時要排除「後台自己 ＋ 它 spawn 的所有子孫」**，
  否則自己開的工具會同時被判成「我開的」跟「外部已在跑」。
- **有 port 的工具有 20 秒寬限期**顯示「啟動中」；過了寬限期 port 還沒通也照樣算「運行中」
  （程序活著），不要永遠卡在啟動中。
- **重啟中間那 1.2 秒要記一筆 `pendingUntil`**（2026-09-03 Benson 回報：「我按了重啟，
  他就沒有寫他在啟動中了」）。重啟＝先 taskkill、隔 1.2 秒再 spawn；那段空窗裡程序真的不在，
  狀態照實算就是「沒在跑」，畫面看起來像按鈕壞了。空窗期一律回 `starting` ＋ `pending:true`。
- **認不出 PID 就去問「誰佔著這個 port」**（`netstat -ano`，2 秒快取）。2026-09-03 之前
  只靠 `processMatch`，對不上就寫「去原本那個視窗關掉」——但面板開的工具是 `windowsHide`，
  **根本沒有視窗**，Benson 完全找不到怎麼關（旅途手帳卡在 port 3618）。
  現在認 PID 有三條路：面板自己開的 → `processMatch` → 佔著那個 port 的。
- **後台結束前一定要跑 `cleanupTools()`**，把自己 spawn 的工具一起帶走。
  桌面 App 以前關窗時用 `Popen.terminate()`（Windows 上是硬殺），
  `process.on('exit')` 不會跑 ⇒ **每重啟一次後台就生一批沒有視窗的孤兒**。
  改成先打 `POST /api/shutdown`（server 自己收乾淨再退），收不動才退回硬殺。
  ⚠️ 寫測試腳本／自動化時同理：**別直接 kill 它**，走 `/api/shutdown`。

### 安全：加了「能啟動任意程序」之後多了兩道

後台本來就綁 `127.0.0.1`。但那擋不住**網頁**：任何網站都可以對 `http://127.0.0.1:4620`
送一個跨來源 POST（simple request 不觸發預檢，回應讀不到但**副作用會發生**）。所以現在：

1. **Host** 一定要是 `localhost`／`127.0.0.1`（擋 DNS rebinding）；
2. 有 **Origin** 的話一定要是後台自己那一頁；沒有 Origin 的（curl／測試腳本）放行——
   那已經是「這台電腦上的程式」，它本來就有完整權限。

這兩條套用在**整個 `/api/`**，不只工具那幾支——包含 2026-09-03 加的
`POST /api/shutdown`（桌面 App 關窗時打，讓 server 自己收乾淨再退）。
那一支能做的事比 `start` 小得多（把面板自己關掉），所以沒有再額外加鎖。

> ⚠️ 這一頁刻意**沒有**「編輯工具清單」的 API。要加工具就自己改 `tools.local.json` ——
> 有寫入 API 的話，上面那道 CSRF 防線一破就等於 RCE。

**信任邊界（想加功能之前先讀這段）**：這一頁上線之後，
**「能改 `tools.local.json` 的人」＝「下次按啟動就能在這台電腦執行任意程式」**。
現在這條邊界是乾淨的，因為那個檔是本機檔、在 `.gitignore` 裡、而且**沒有任何 API 寫得到它**
（全檔的寫檔動作目標都是模組層級常數，不接受請求資料組路徑）。
所以哪天有人想做「線上編輯工具清單」「從手機加工具」這類功能，
要先想起這句話 —— 那等於把 RCE 的入口從「本機檔案」搬到「網路請求」。

另外一個這次被放大、但判定可接受的面：後台**沒有密碼**（原本的設計前提是「只有這台電腦」），
而 `Origin` 檢查對「不帶 Origin 的請求」是放行的（curl／測試腳本要能用）。
所以**這台機器上的其他本機程序**可以呼叫 start／stop。風險增量很小
——能在這台機器上跑程式的攻擊者，本來就能直接讀 `secrets.json`——但要心裡有數。

### 刻意不做 3 秒輪詢

tool-manager 是每 3 秒重抓一次。這個後台的 `render()` 是**整片 `innerHTML` 重建**，
每 3 秒重建一次會把滑鼠底下的按鈕抽掉（travel-book／trade-log 都踩過這個）。
改成：進分頁載一次 → 按了啟動／停止之後追幾次（最多 4 次，約 10 秒）→
其餘時候按「🔄 重新整理」。畫面上誠實寫「狀態是 HH:MM 抓的」。

> ⚠️ 追蹤的條件是**「按過按鈕就追」**，不是「只在有工具是啟動中時才追」。
> 原本寫成後者，結果按完重啟的第一次回頭問，狀態還在空窗期（那時回的是「沒在跑」），
> 條件不成立 → 追蹤直接停掉 → 畫面就卡在「沒在跑」不動了。（2026-09-03 修）
> 現在是：按過就追 4 次，而且只要看到還有人是「啟動中」就把次數補滿。

### 改完要跑

```
node tools/check-tools.js          # 工具分頁 54 條（沙箱＋自己造的假工具，不會去開真的那幾支）
node tools/check-tools.js --only=B # 只跑其中一組
```

| 組 | 驗什麼 |
|---|---|
| A | 清單搬遷（tool-manager 的 9 筆一個不漏） |
| B | 啟動／停止：taskkill 殺的是整棵樹 |
| C | 偵測「不是我開的但已經在跑」，排除面板自己與子孫 |
| D | 突變：拿掉子樹排除，C2／C3 必須翻紅 |
| E | 只接受本機連線 ＋ 跨來源 POST 被擋 |
| F | 重啟：中間那 1.2 秒不准說「沒在跑」 |
| G | 突變：拿掉重啟的空窗標記，F2 必須翻紅 |
| H | 孤兒：只有 port 認得出來的也要停得掉 |
| I | 收工：`/api/shutdown` 要把面板開過的工具一起帶走 |

D／G 是突變測試（把補丁那行拿掉，對應的斷言必須**翻紅**，不然等於沒在驗）。
B6／C1／C4／E1／E4／F5／H1／H2／I1 是負控組（先證明尺是活的）。

> 沙箱那台 server 一律走 `stopServer()`（打 `/api/shutdown`）收掉。
> 以前是直接 `ps.kill()`，假工具會活下來，**下一次跑整套時 B 組會被上一輪的殘骸擋住**
> （「已經有外部程序在跑了」）。真的留下殘骸時：把指令列含 `__tmp__` 的程序 taskkill 掉。

## 別的 App 要導入（三步）

1. 把 `client/keyring-unlock.js` 複製到那個 App 的前端資料夾（自帶樣式、零依賴、單一檔）。
2. `index.html` 在自己的 app.js **之前**載入它；PWA 的話把它加進 service worker 的 shell 快取清單。
3. 決定資料層之後呼叫一次：

```js
Keyring.init({
  appId: "recipe-book",            // 要跟後台登記的「代號」一模一樣
  tokenKey: "recipe_gh_pat",       // 這個 App 原本存金鑰的 localStorage key（不用改）
  enabled: !STORE.local,           // 本機版不需要鑰匙
  toast: myToast,                  // 借用 App 自己的 toast
  onChange: function(){ reloadData(); }
});
```

然後：footer 放 `Keyring.chipHtml()`；寫入守門處改成 `Keyring.open("動作名")`；
首頁畫完呼叫一次 `Keyring.maybeIntro()`（第一次進站主動端一次解鎖，之後永遠不再自動彈）。

### 以後改一次就好：其他 App 自動跟上

第 1 步的「複製一份」只做一次。之後**只改這個 repo 的 `client/keyring-unlock.js`**，
`.github/workflows/sync-unlock.yml` 會在 push 後自動把它 commit 進每個 App 的
`public/` 與 `docs/`（`docs/` 是 `build.js` 的產物，但它進版控、而 `build.js` 只跑在
Benson 的電腦上，所以兩份都由 CI 寫）。手機上什麼都不用做。

- **新增一個 App**：在那支 workflow 的 `matrix.app` 加一行 `{ repo: xd1104/xxx, label: 名字 }`。
- **手動重跑**：Actions 分頁 →「同步解鎖模組到各 App」→ Run workflow。
- **檔案已經一致**就不會產生空 commit；某個 App 失敗不會拖累另一個（`fail-fast: false`）。

需要一把 secret：**`APP_SYNC_TOKEN`**（Settings → Secrets and variables → Actions）。
fine-grained PAT，Repository access 只勾 matrix 裡那幾個 repo，權限只給
**Contents: Read and write**。沒設的話 workflow 會印一行黃字提醒然後跳過，不會噴紅。

> 這把 token 跟「每個 App 一把、只授權自己那一個 repo」那條鐵律管的不是同一件事：
> 那條講的是**會被加密進公開 `keyring.json`、最後跑進瀏覽器**的 App 金鑰；
> 這把只住在 Actions secret，不進瀏覽器、不進 `keyring.json`。

⚠️ **`demo/unlock-v3.html` 不在同步範圍內**——它是一份手抄的重寫版（把模組塞進 iframe 的
`srcdoc` 來試玩假資料），不是拷貝，同步腳本蓋不過去。它已經落後本體一整組矮螢幕自適應
（`kr-short` / `kr-tiny` / `kr-micro`）。**看 demo 的時候記得它不等於線上的樣子。**

### 視覺：新 App 接進來零設定（v3 公版，2026-08-20 Benson 拍板）

**解鎖畫面是跨 App 的公版，不用調任何顏色、不用在你的 CSS 裡寫一條 `kr-` 規則。**
它是一層滿版的暖墨深色（`rgba(26,21,16,.955)` ＋ 頂部暖光 ＋ backdrop blur），
**每個 App 長得一模一樣**——因為「解鎖」是進 App 之前的一層，本來就不屬於任何一個 App 的視覺語言。
左上角用一行文字（預設取 `document.title`，也可以 `init({appName:"🧭 旅途手帳"})`）告訴使用者這是哪個 App，
**靠文字不靠顏色**：零調色成本、零撞色風險。

唯一可選的鉤子：**身分藥丸**（`chipHtml()`，它住在你的畫面裡）。
設一個 `--acc` 就能讓「點我解鎖」那幾個字跟著 App 走；不設就用模組預設 `#c1553f`。
**鐵律：主色只准上前景（文字／圖示／1px 框），藥丸底色永遠是模組固定的中性色 `#f6f2ea`。**
（v2 曾讓底色寫死粉色、字吃 `--acc`，橘色 App 一接上去就是粉底＋橘字——「一半吃變數、一半寫死」
接第 N 個 App 就會再壞一次，v3 從根上拿掉了這個狀態。）

> 給改這個模組的人：`#kr-full` 子樹內**一個宿主變數都不准讀**，連 `var(--acc, fallback)` 都不行。
> 模組自己的常數用 `--krs-*` 前綴，定義在 `#kr-full` 上。

### 改完模組請跑機器驗收

```
node tools/check-unlock.js            # 全部 38 條（要 Chrome ＋ 旁邊的 travel-planner／recipe-book）
node tools/check-unlock.js --only=A,B # 只跑某幾組

node tools/check-fields.js            # 多欄位＋公開模式 109 條（純 node，零依賴）
node tools/check-fields.js --only=B   # A 邏輯／B 向後相容／C 後台 API／D 模組 CSS／E 後台畫面
                                      # F,G 紅線：回應不含明文／H,I 公開模式／J 模組的公開行為
```

`check-fields.js`（A 邏輯／B 向後相容／C 後台 API／D 模組 CSS／E 兩個後台的畫面／F 紅線）全程用假金鑰、只在 `os.tmpdir()` 底下讀寫，**不會碰到
`keyring.json`／`vault.json`／`secrets.json`**。它的 B 組會用 `git show main:server.js`
把**改動前**的後台叫出來跑一次，兩份 `keyring.json` 逐項比對 —— 這是「舊 App 沒被影響」的機器證明。

零依賴（自己開 headless Chrome ＋ 本機測試宿主，用假 token 跑真的 PBKDF2＋AES-GCM）。
它守的是：密度 class 底下不准有動畫、`#kr-full` 讀宿主變數必須 0（**走 live CSSOM 不是 grep**——
grep 會被註解與「同一條規則裡被後面蓋掉的宣告」誤報）、三個宿主 computed style 逐項相同、
觸控目標 ≥44px、四條動畫路徑不重播、矮螢幕五階不被切、底部不露白（含反向對照）、減少動態真的不播。

### 這個模組還做了什麼

- **換金鑰不用重解鎖**：裝置記著的是派生金鑰，每次載入會用它把最新的密文解開，PAT 換新就自動換過去。
- **換密碼／被刪／被收回權限 → 靜默降級**：解不開就清掉本機記憶、回到「只看看」，並提示一次。
- **沒勾「記住這台裝置」**：身分與金鑰只進 `sessionStorage`，關掉分頁就沒了（別人的電腦用）。
- **離線**：抓不到 `keyring.json` 就維持現狀，不會把人踢回唯讀。
- 救援用：`localStorage["keyring.<appId>.src"]` 可以指到別份鑰匙圈（例如本機後台的 `http://localhost:4620/keyring.json`）。

## 金鑰分開是刻意的

每個 App 一把 fine-grained PAT、**只授權它自己那一個 repo** 的 Contents。
不要為了省事發一把「全部 repo 都能寫」的金鑰——那條界線不能打破。
