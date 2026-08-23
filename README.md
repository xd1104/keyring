# 🔑 鑰匙圈（keyring）

一人一組密碼，任何裝置輸一次就能編輯我做的那些 GitHub Pages App（旅途手帳、食譜本…）。
不用再把一長串 GitHub PAT 貼來貼去。

## 為什麼這樣做

Pages 是純靜態、**沒有伺服器可以驗密碼**。所以：

1. 後台（電腦上的 `server.js`，或手機上的 `web/`）把每個 App 的 PAT **用每個人的密碼各加密一份**。
2. 密文寫進 `keyring.json`，自動 push 到這個公開 repo。
3. App 前端抓 `keyring.json`，使用者選自己、輸密碼，**在瀏覽器裡**用 WebCrypto 解開，
   把解出來的金鑰寫進那個 App 原本就在用的 localStorage key。

密碼錯的唯一症狀就是「解不開」（AES-GCM 驗證失敗），所以檔案裡**不需要、也沒有**密碼或密碼 hash。

## 四個檔案（別搞混）

| 檔案 | 內容 | 會不會上傳 |
|---|---|---|
| `secrets.json` | **明文 PAT** ＋ 每個人的派生金鑰 | ❌ 在 `.gitignore` 裡，永遠只在這台電腦 |
| `keyring.json` | 只有 salt／iv／密文 | ✅ 這就是要發布的東西 |
| `vault.json` | 整份 `secrets.json` 加密後的樣子（給手機後台用） | ✅ 是密文，但要有管理密碼＋配對碼才解得開 |
| `vault.key` | 解 `vault.json` 的金鑰＋這台電腦的配對碼 | ❌ 在 `.gitignore` 裡，跟 `secrets.json` 同一級 |

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

雙擊 `start.bat`，或用 tool-manager 面板 →「AI 工具」→ 鑰匙圈。網址 <http://localhost:4620>。
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
node tools/check-unlock.js            # 全部 38 條
node tools/check-unlock.js --only=A,B # 只跑某幾組
```

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
