# 鑰匙圈（keyring）設計規格 v1

> lab-ux 產出，給 lab-dev 照做。可試玩 demo：`keyring/demo/index.html`（單檔、零依賴、雙擊即開）。
> 狀態：**待 Benson 試玩確認方向**。確認後才進實作。

---

## 0. 一句話

> 每個人有自己的名字＋密碼。任何裝置打開 App → 點自己的頭像 → 輸密碼 → 就能編輯，而且這台裝置從此記住。

## 1. 技術前提（不用實作，但決定了 UI 能講什麼話）

GitHub Pages 是純靜態、**沒有伺服器可以驗密碼**。金鑰是用每個人的密碼各加密一份、密文放在公開的鑰匙圈 repo，前端在瀏覽器裡解開。

由此推出三條 UI 鐵律：

1. **密碼錯的唯一症狀是「解不開」**——沒有「帳號鎖定」「錯 5 次停權」，不要做假的。
2. **沒有「忘記密碼」自助流程**——只能請 Benson 到後台換一組新的。文案要誠實這樣寫。
3. **後台看不到舊密碼**（只有密文）——「換密碼」不是「查密碼」。

> 文案禁區：不要出現「驗證失敗」「認證錯誤」「授權中」「登入」這種系統腔，也不要暗示有伺服器（例如「連線至伺服器」）。

## 2. 兩個介面

| 代號 | 介面 | 跑在哪 | 優先 |
|---|---|---|---|
| A | 解鎖畫面 | 旅途手帳前端裡（Pages 版） | 手機優先 |
| B | 鑰匙圈後台 | Benson 自己的電腦（本機小工具網頁） | 桌面優先 |

---

# A. 解鎖畫面（旅途手帳內）

## A1. 形式判斷：底部 sheet，不做整頁鎖屏 ✅

**選底部 sheet。理由：**

- 這個 App **唯讀是合法狀態**——旅行中最常做的事是「看今天行程」。整頁鎖屏等於要求每個人先做一次身分決策才准看，跟產品本質相反。
- 女友在別人手機上開來看一眼，鎖屏會像「這不是給你用的」。sheet 則是「你已經在裡面了，要改再解鎖」。
- 手機上 sheet 底部升起＝拇指可及；鎖屏的按鈕通常在畫面中間偏上。
- 後面看得到內容 ⇒ 使用者知道自己沒有離開 App，關掉 sheet 沒有代價。

（另一案：**整頁鎖屏**。適合「不解鎖就完全沒東西可看」的產品，或安全感要拉滿的場合。本專案不是，故不採用。）

**唯一例外——首次進站主動端一次**：這台裝置從來沒解鎖過、也沒看過這個 sheet 時，進站 ~0.9 秒後自動升起解鎖 sheet 一次（可下滑／✕／「先看看就好」關掉），之後**永遠不再自動彈**。解決「女友根本不知道有解鎖這回事」的發現性問題，又不會變成每次都被擋。
旗標：`keyring.introSeen = "1"`。

## A2. 「現在是誰」的落點：首頁 footer 身分列 ✅

沿用現有 `home-foot`，把原本那行 `唯讀模式・貼上金鑰即可編輯` 換成一顆**身分藥丸**，第二行才是原本的「設定・重新整理・版本」連結。

| 狀態 | 藥丸 | 樣式 |
|---|---|---|
| 未解鎖 | `🔒 只看看模式・點我解鎖` | 底 `#fff1ef`、字 `--acc-deep`、框 `#ffd9d3`（淡淡邀請感） |
| 已解鎖 | `[漸層小方塊 emoji] 女友・可以編輯` | 底 `#f3eee4`、字 `#6b6154`、框 `--line`（安靜） |
| 本機版 | 不顯示（本機不用鑰匙） | — |

規格：`min-height:44px`、`border-radius:99px`、`padding:0 16px`、`font-size:13.5px/700`；漸層小方塊 24×24、`border-radius:8px`。

> 為什麼不放頂部：旅程頁的 header 是旅程的漸層封面，塞身分會搶主體；而 footer 是使用者已經習慣「這裡放狀態」的地方（原本的唯讀提示就在那）。

## A3. 狀態機

```
                 ┌──────────────── 只看看（唯讀）────────────────┐
                 │  進站無記憶 → 首次自動升起 sheet 一次        │
  [未解鎖] ──────┤  點身分藥丸 / 點任何寫入入口 → 升起 sheet     │
                 └──────────────────────────────────────────────┘
                          │ 選人
                          ▼
                    [輸密碼中] ──送出──▶ [解開中…]（0.5~1s，按鈕轉圈、禁重複送）
                          ▲                   │
                          │ 密碼不對          │ 解開成功
                     [密碼錯誤]◀──────────────┤
                                              ▼
                                          [已解鎖]（記住這台裝置＝勾選時）
                                              │ 身分藥丸 → 換人 → 確認
                                              ▼
                                          回到 [未解鎖]
```

清 state 的三個時機：① 使用者按「換人」；② 後台換了他的密碼／刪了他（下次載入解不開，靜默回未解鎖並提示一次）；③ 沒勾「記住這台裝置」時，關掉分頁即失效（存 sessionStorage）。

## A4. 畫面規格

### A4-1 解鎖 sheet ─ 步驟 1「誰在用？」

- sheet：`border-radius:22px 22px 0 0`、`padding:14px 18px calc(22px + safe-area)`、`max-height:90dvh`、上方 38×4 grab bar、右上 ✕（44×44）。
- 若是被寫入動作叫出來的，最上面一條**理由條**：底 `#fff1ef`、字 `--acc-deep`、13.5px：`要「規劃新旅程」得先解鎖，選一下你是誰就好。`
- 副標（muted 14px）：`選你自己，輸入密碼，這台裝置就記住了。`
- **頭像磚**：2 欄 grid、gap 12、`min-height:116px`、`border-radius:18px`、每人自己的**漸層**（沿用 travel-book `THEMES`）、左上 emoji 34px、左下名字 17px/800 白字＋文字陰影；`:active` scale .97。
  - 人多時往下排即可（3 人＝2+1，靠左；不要為了對稱補空磚）。
- **只看看區**（磚下方，`border-top:1px solid #f2ecdf`、`padding-top:16px`、置中）：
  - 一行灰字 13px：`不用密碼也能看，只是不能改東西。`
  - 連結鈕：`先看看就好 →`（15px/700、`#6b6154`、底線、44px 高）。

### A4-2 步驟 2「輸密碼」

- 左上 `‹ 換一個人`（多人時才出現）、右上 ✕。
- 大頭像 74×74、`border-radius:22px`、漸層＋emoji 36px、置中。
- 標題置中 21px/800：`嗨，女友`；副標 13.5px muted：`輸入你的密碼，就可以編輯了`
- 密碼欄：`type=password`、**font-size 16px**、右側 48×48 👁 切換顯示（顯示中換 🙈）、`autocomplete="current-password"`、`autocapitalize="off"`、`spellcheck="false"`。
- 勾選列：`記住這台裝置` ＋ 小字 `下次打開就直接能編輯。別人的電腦記得取消。`（**預設勾選**；未勾＝只存 sessionStorage）。
- 主鈕：`解鎖`（52px、`--acc`）；送出中變 `⟳ 解開中…`＋disabled。
- 底部再放一次 `先看看就好 →`（有些人到這一步才發現自己不想輸）。
- **Enter 送出**：包 `<form>` ＋ `type=submit`（IME 組字不誤送）。

### A4-3 密碼錯誤

- **inline 錯誤條**（不用 alert、不清空整個畫面）：底 `#fbeeee`、字 `--bad` 13.5px/700：
  `密碼不對，再試一次`
- **第 2 次起**追加第二行（muted 12.5px）：`想不起來的話跟 Benson 說一聲，他那邊可以幫你換一組新的。`
- 密碼欄清空並重新 focus。**不做**次數鎖定、不做倒數、不變紅整個 sheet。

### A4-4 已解鎖 → 身分 sheet（點藥丸）

- 大頭像 56×56 ＋ 名字 18px ＋ 灰字 `這台裝置記住了你的鑰匙，可以編輯`
- `🔄 換人用`（ghost 鈕）→ 二段確認 sheet：
  - 琥珀提示框：`換人會把這台裝置記住的鑰匙清掉，回到「只看看」。下一個人自己選名字、輸密碼就好。`
  - `清掉，換人`（danger）／`先不要`（ghost）
  - 確認後：清 state → 直接升起「誰在用？」→ toast `已經清掉，換誰用都可以`
- `好，繼續用`（primary）關閉。

### A4-5 只看看模式：寫入攔截 ✅

**不要只丟 toast。** 現行 `requireWrite()` 的 toast（`唯讀模式：到下方「設定」貼上金鑰才能編輯`）要求使用者自己回首頁往下找，太遠。

新規則：**任何寫入入口被點到 → 直接升起解鎖 sheet，並帶上理由條。**

需要接管的入口（travel-book）：新增旅程、編輯旅程、刪除旅程、FAB ＋（行程點／移動）、行程點編輯／刪除、調整模式（拖曳）、花費新增／刪除、打包勾選／新增／模板、備註 textarea（維持 readonly，點下去也升 sheet）。

理由條文案 = `要「<動作名>」得先解鎖，選一下你是誰就好。`（動作名照入口給：`規劃新旅程`／`改這個行程點`／`記一筆花費`／`勾打包清單`／`寫備註`…）

## A5. 其他判斷

**只有一個使用者時 → 跳過選人，直接進輸密碼。** 理由：沒有可選的東西就不要假裝有；但**仍然顯示他的大頭像＋名字**（確認「這台鑰匙圈是誰的」），且不顯示「‹ 換一個人」。這是同一個 sheet 的 render 規則，不是另一個畫面。

**「只看看」跟「解鎖」的層級**：解鎖＝彩色大磚（主動作）；只看看＝分隔線下方的**底線文字連結**（次動作，但用正常深灰、**不用 danger 色、不做 disabled 樣子**），並在上面加一句「不用密碼也能看，只是不能改東西」把它講成一個**正常選項**而不是放棄。文案用「先看看就好」不用「取消」「略過」——後者暗示他做錯事。

**沒有「重新輸入金鑰」這種字眼**了。使用者心智裡不該再出現 PAT。（原「設定」頁保留給進階／救援用，但不再是主要路徑。）

---

# B. 鑰匙圈後台（桌面優先）

版面：置中 `max-width:980px`，暖米白底，同一套色票。無側欄（東西太少，側欄是浪費）。

```
🔑 鑰匙圈
管理誰可以編輯哪個 App。改完記得發布。
┌──────────────────────────────────────────────┐
│ 發布狀態列（綠＝乾淨／琥珀＝有未發布）  [發布出去] │
└──────────────────────────────────────────────┘
[ 👥 使用者 ][ 📦 App 金鑰 ]      ← segmented（沿用 .seg 樣式）
… 卡片列表 …
腳註：密碼是各自加密的，這裡看不到、也救不回來。
```

## B1. 發布狀態列（未發布提示的強度判斷 ✅）

**判斷：常駐橫幅，中強度；不做 modal、不做離開攔截。**

- 乾淨：綠底 `#e8f6ef`／框 `#cfe9dd`，`✓ 都發布了`＋`上次發布 8/16 21:40　各裝置打開就是最新的`；發布鈕**灰階**（點了只 toast「沒有東西要發布」）。
- 有未發布：琥珀底 `#fff6e3`／框 `#f2dcae`，`有 3 項改動還沒發布`＋`看改了什麼`（展開逐條清單：`新增了使用者「女友」`…）；發布鈕轉成 `--acc` 主色＋陰影。
- 發布中：鈕文字 `發布中…`＋disabled；完成 toast：`發布好了，各裝置下次打開就會拿到新的鑰匙圈`。

為什麼不更兇：這個後台只有 Benson 一個人用、改動可以攢著一起發，攔他等於每次都要多按一次「知道了」。**顏色從綠翻琥珀＋主鈕變色**已經是視野內最顯眼的變化了。
（正式版可加：關閉分頁時若有未發布，用 `beforeunload` 提醒——**這條留給 Benson 拍板，預設不做**。）

## B2. 使用者頁

卡片列（`.rowcard`：白卡、圓角 18、陰影）：`52×52 漸層頭像`｜`名字 17px` ＋ 下方 App chips（沒有權限時顯示灰 chip `還沒給任何 App`）｜右側動作 `編輯`／`換密碼`／`刪除`（各 44px 高）。
最後一列：虛線 `＋ 新增使用者`（沿用 `.add-trip` 語彙）。

### 新增使用者表單順序 ✅

`名字 → 頭像 emoji → 顏色 → 可以用哪些 App → 密碼 → [建立]`

**理由：密碼放最後**——它是唯一一個「填完就要馬上講給對方聽」的東西，緊接著就是建立成功畫面（交接說明），動線連在一起。前面四項是「這個人長什麼樣」，一路都在描述人；權限是「他能碰什麼」，屬於人的屬性，也放在描述區；密碼是「交付動作」，獨立在最後一段。
另：新增時 App 權限**預設全勾**（家用情境常態是都給），要收再取消，比全不勾少點兩下。

欄位規格：

| 欄位 | 型別 | 規則 |
|---|---|---|
| 名字 | text | 必填，唯一提示：`先幫他取個名字` |
| 頭像 | emoji 快選 12 個（48×48 磚） | 預設 🧑 |
| 顏色 | 5 個漸層 swatch（同 travel-book THEMES） | 選中＝白框＋珊瑚 ring＋✓ |
| 可以用哪些 App | checkbox 卡（60px 高，含 App 名＋網址小字） | 預設全勾 |
| 密碼 | password＋👁 切換 | **必填但不驗強度** |

### 密碼強度：柔性提示，絕不擋 ✅（硬性條件）

輸入時即時顯示一行 12.5px 灰字，**只是描述、不是警告**，且**永遠允許存檔**：

- 少於 4 字：`這組很短，記得住就好——存得下去。`
- 全數字且短：`全是數字，有點好猜——不擋你，想清楚就好。`
- 其他：`看起來可以。`

**禁止**：紅色錯誤樣式、disabled 送出鈕、彈出確認框、強制規則文案（「需包含大小寫」）。

### 建立成功 → 交接畫面 ✅（要做）

Benson 怎麼告訴女友？**口頭就好，但我們把話寫好給他複製**——因為要講的不只是密碼，還有「點哪裡」。

- 綠框：`👩 女友 的鑰匙已經配好` ＋ `還要按上面的「發布出去」，他那邊才拿得到。`
- 一段可複製的白話文（照他的第一個 App 產生）：

```
旅途手帳可以編輯囉：
1. 打開 https://xd1104.github.io/travel-book/
2. 點最下面那條「只看看模式・點我解鎖」
3. 選「女友」，密碼是 abcd
之後這支手機就記住了，下次打開直接能改。
```

- `📋 複製這段話` ＋ 灰字提醒：`這段話裡有密碼，傳完記得把訊息刪掉。`
- 同一個畫面在**換密碼成功**時也出現（標題改「密碼換好了」）。

### 換密碼

`舊密碼看不到也想不起來，直接給一組新的就好。` ＋ 新密碼欄（同柔性提示）＋琥珀提示：`換了之後，他已經解鎖過的裝置會回到「只看看」，要用新密碼再解一次。`

### 刪除

自製確認 sheet（不用 `confirm()`）：`刪掉之後他就不能再編輯了（已經打開的裝置，下次重整就變成只看看）。` → `刪掉`(danger)／`算了`。

## B3. App 金鑰頁

卡片：`圖示`｜`App 名` ＋ **遮罩金鑰** `github_pat_11AB••••••••3f`（等寬字、`#faf6ee` 底、圓角 10）＋ 誰可以用 chips｜動作 `換金鑰`／`誰可以用`／`刪除`。

- 新增 App：名稱、圖示、網址、金鑰（`貼這一次就好，之後只會顯示前後幾個字。`）。
- 換金鑰：顯示目前遮罩 → 貼新的；提示 `換金鑰不用改任何人的密碼，發布之後大家自動換到新的。`
- 誰可以用：使用者 checkbox 清單（權限的第二個入口，App 視角）；灰字 `沒勾的人，解鎖後也拿不到這個 App 的鑰匙。`
- 刪除 App：`刪掉之後，所有人都拿不到這個 App 的鑰匙了。`

> 權限做兩個入口（人視角在使用者表單、App 視角在這裡），兩邊寫同一份資料。不做矩陣表格——兩個人兩個 App 用矩陣是殺雞用牛刀。

---

## 3. 視覺規格（兩邊共用）

沿用旅途手帳：`--bg:#f7f4ee` `--card:#fff` `--ink:#2b2620` `--muted:#8f8578` `--line:#e8e1d5` `--acc:#ff6b5e` `--acc-deep:#e2503f` `--ok:#2fa87a` `--bad:#d64545`，`--shadow:0 2px 14px rgba(70,55,30,.08)`。
琥珀（未發布／提醒）：底 `#fff6e3`、框 `#f2dcae`、字 `#8a5b12`。
圓角：卡片 18–20、sheet 22、欄位 13、鈕 15、chip/藥丸 99。
漸層（人＝一個顏色，沿用 travel-book `THEMES`）：sunset／ocean／night／forest／sand。
空狀態：大 emoji ＋一句人話 ＋ CTA（沿用 `.empty`）。

## 4. 鐵律（違反＝退件）

1. 所有 `input/textarea/select` **font-size ≥ 16px**（iOS 自動放大）。
2. 觸控目標 ≥ 44px（含 sheet 的 ✕、👁 切換、文字連結）。
3. 密碼**不設強度限制**、不擋存檔、不跳警告框。
4. Enter 送出走原生 `<form>` + `type=submit`。
5. 不用 `alert/confirm`，一律自製 sheet／dialog。
6. 文案不用系統腔、不暗示有伺服器、不出現「PAT」給一般使用者看。
7. 底部固定區塊要 `env(safe-area-inset-bottom)`。
8. 資源相對路徑（Pages 子路徑）。

## 5. 命名建議（dev 可調）

- 裝置記憶：`keyring.device` = `{userId, name, emoji, theme, at}`（勾記住＝localStorage；沒勾＝sessionStorage）
- 首次導引旗標：`keyring.introSeen`
- 解鎖後拿到的 App 金鑰仍沿用各 App 既有的 key（travel-book：`travel_gh_pat`），**換人時一併清掉**。
- 狀態常數：`locked` / `unlocking` / `unlocked`。

## 6. demo 沒做、正式版要做

- 真的加解密（把密文換成真金鑰）、鑰匙圈 repo 的讀取與快取。
- 後台真的 push（發布）、失敗處理（網路斷、金鑰過期）。
- 密碼換掉／使用者被刪之後，舊裝置下次載入解不開的**靜默降級**＋一次性提示：`鑰匙換過了，要用新密碼再解一次`。
- 旅程頁（非首頁）也要看得到身分：目前只在首頁 footer；若 Benson 覺得不夠，再在旅程頁 header 加一顆小頭像。
- 多 App 時的「這個人只有一把鑰匙 vs 好幾把」在解鎖後的呈現（目前不需要）。

## 7. 想請 Benson 拍板

1. **解鎖用底部 sheet（推薦）vs 整頁鎖屏**——我做的是 sheet，理由見 A1。
2. **首次進站自動彈一次解鎖 sheet**（推薦做，解決發現性）——會不會覺得煩？
3. **未發布變更只用琥珀橫幅提醒（推薦）**，還是關掉後台時也要攔一下？

---

*demo 試玩密碼：Benson＝`1234`／女友＝`abcd`；右上「重置 demo」回到「這台裝置沒解鎖過」的狀態。*

---

# 解鎖畫面 v2 視覺改版（2026-08-18・lab-ux）

實作已上線，功能驗收過，但視覺不對。**只改視覺，狀態機、sheet 形式、「記住這台裝置」、密碼顯示切換、唯讀入口全部不動。**

Demo：`demo/unlock-v2.html`（雙擊即開；四格並排＝現況／A／B／C，上方切「選人／輸密碼／密碼錯了」）。

## 1. 我的診斷（跟 PM 的假設不同）

PM 懷疑「頭像磚那兩組漸層不在 App 的色票裡」。**這點不成立**：`#38c3a7→#2f8fd6` 就是 `THEMES.ocean`、`#ff8a80→#ff5f7e→#c94b9d` 就是 `THEMES.sunset`，都是 travel-planner `app.js` 自己的顏色。真正的問題有三層：

1. **語意借錯層**。在旅途手帳裡，這幾組漸層只代表一件事：**一趟旅程**（`.cover` 旅程封面、`.mem-emoji` 回憶列）。把它套到「人」身上，等於宣告身分是內容；但身分是介面外框（chrome），不該跟旅程搶同一種視覺語言。使用者看到的是「兩張沒有名字的旅程卡」。
2. **面積與密度超標**。App 任何一個畫面同時只出現一塊大漸層（一張卡一個封面，外面包白卡＋米色 meta 列稀釋）。解鎖 sheet 一次放兩塊 116px 滿彩度色塊、只隔 12px、底下是純白，**這是全 App 最吵的一格畫面，卻是最不重要的內容**。加上封面用的 `text-shadow`／`drop-shadow` 是為 110px 大圖調的，縮到 34px emoji 就只剩糊。
3. **同一件事講四次**。標題「誰在用？」＋副標「選你自己，輸入密碼，這台裝置就記住了。」＋兩塊磚＋「不用密碼也能看…」＋「先看看就好 →」，sheet 高 357px，而實際只是要按一下自己的名字。
4. 附帶：**珊瑚色 `--acc` 在第一步完全沒出現**，所以這張 sheet 不像這個 App 的東西。

## 2. 三個方向

| | A・一行式 | B・暖卡列（推薦） | C・兩顆按鈕 |
|---|---|---|---|
| 頭像 | 完全拿掉 | 44px、漸層壓到 ~20% 當底 | 完全拿掉 |
| 排版 | 名字列（抄 `.mem-row`） | 橫向卡列 | 兩顆全寬按鈕 |
| 主色 | 只有按鈕是珊瑚 | 只有按鈕是珊瑚 | 選人步驟就用珊瑚 |
| sheet 高 | ~235px | ~265px | ~250px |
| 取捨 | 少了一眼認人的親切感 | 比 A 多一層卡片 | 主次是猜的（靠上次解鎖的人） |

- **A（大幅減法）**：拿掉頭像、拿掉副標、把「不能改東西」併進連結文字。整張 sheet 只剩白＋墨色＋一顆珊瑚鈕，後面的旅程封面重新變回畫面上最亮的東西。零新元件。
- **B（推薦）**：保留辨識、但把身分從「內容層」降到「配角層」——同一組 `THEMES` 漸層壓到 20% 當 44px 頭像底色，認得出誰是誰，卻不再是色塊。一列一個人，右邊可掛一行小字（例「上次是這位用這台」），之後加人不爆版。
- **C**：把選人做成兩顆全寬按鈕（用 App 現成的 `.btn-primary`／`.btn-ghost` 語彙）。最像「一句話問完」、觸控目標最大；但要靠「上次解鎖的人」決定誰是珊瑚色，猜錯時第二個人會覺得自己是次要的。

## 3. 我推薦 B

理由：①**唯一同時解掉「太吵」和「不失溫」的**——旅途手帳整體是 emoji 很重的語言（旅程、行李區都有 emoji），A 全拿掉會比 App 其他地方更冷；②漸層仍在，但降到 20%＋44px，**語意上明確是「一個人的標記」而不是「一趟旅程」**；③卡列是唯一往上長得動的排版（第三、第四個人加進來不用重設計）。
A 是安全備案（如果 Benson 要更靜）；C 適合「這台就是我的手機」的假設成立時，但那是功能決策，不該在純視覺這輪順便改。

## 4. 定案後 lab-dev 要改哪些（以 B 為例）

檔案：`client/keyring-unlock.js`（正本，改完複製給各 App）。**只動 CSS 字串與兩處 template；JS 流程、事件、狀態不動。**

**新增常數**（放在 `THEMES` 旁）：頭像底色用的柔化表，別在 runtime 算 alpha。

| theme | tint（頭像底） |
|---|---|
| sunset | `linear-gradient(135deg,rgba(255,138,128,.24),rgba(201,75,157,.20))` |
| ocean | `linear-gradient(135deg,rgba(56,195,167,.24),rgba(47,143,214,.20))` |
| night | `linear-gradient(135deg,rgba(106,123,240,.22),rgba(142,84,201,.20))` |
| forest | `linear-gradient(135deg,rgba(126,201,111,.26),rgba(63,157,138,.22))` |
| sand | `linear-gradient(135deg,rgba(245,198,93,.30),rgba(240,133,92,.24))` |

**第一步（選人）**
- `.kr-grid`：`grid` → `display:flex; flex-direction:column; gap:8px;`（class 名不改，省得動 JS）。
- `.kr-tile`：改成橫向列 — `flex-direction:row; align-items:center; gap:12px; min-height:64px; padding:10px 12px; border-radius:16px; background:#fbf9f4; border:1px solid #efe9dd; color:var(--ink); text-align:left;`。**移除 `color:#fff`**。`:active` 改 `background:#f5f1e8`（不要 scale）。
- `sheetWho()` 那行的 inline `style="background:grad(u.theme)"` **從 `.kr-tile` 移到 `.em`**，值改用上表的 tint。
- `.kr-tile .em`：`width:44px; height:44px; border-radius:14px; font-size:23px; display:flex; align-items:center; justify-content:center; flex:0 0 auto;` **拿掉 `filter:drop-shadow(...)`**。
- `.kr-tile .nm`：`font-size:16.5px; font-weight:700;` **拿掉 `text-shadow`**；外面包一層 `.kr-tx`（新增，`flex:1; min-width:0;`），底下可放 `.kr-tile .sub`（新增，`font-size:12.5px; color:var(--muted); margin-top:2px;`）給「上次是這位用這台」。
- 新增 `.kr-tile .go`（`›`，`font-size:18px; color:#cfc5b3;`）放最右。
- `.kr-sub` 文案改「選自己、輸密碼，這台就記住了。」，樣式 `margin:2px 0 12px; font-size:13.5px;`。
- `.kr-peek`：**刪掉裡面的 `<p>`**，只留 `.kr-peek-link`，文案改「先看看就好（不能改東西）」；`.kr-peek` 改 `margin-top:10px; padding-top:6px;`。

**第二步（輸密碼）**
- **拿掉 `.kr-face`（74px 大頭）、`.kr-title`、`.kr-saytxt` 三個置中區塊**，改用既有的 `.kr-id` / `.kr-id-face` 橫列：`.kr-id-face` 尺寸 56 → `44px/14px radius/23px emoji`、背景改吃 tint（不是 `grad`）；`.kr-id b` = 名字（18px），`.kr-id span` = 「輸入密碼就可以編輯」。
- `.kr-field`、`.kr-eye`、`.kr-err`、`.kr-check`／`.kr-box`／`.kr-lb`、`.kr-go`、`.kr-peek-link`：**完全不動**。

**若改選 A**：`.kr-grid` 同樣改直向、`.kr-tile` 改成 `min-height:60px; padding:0 18px; margin:0 -18px; border-top:1px solid #f2ecdf; background:none; border-radius:0;`，`.em` 整個不 render，`.nm` 17px/700；第二步把 `.kr-face` 拿掉、`.kr-title`／`.kr-saytxt` 改左對齊。
**若改選 C**：`.kr-tile` 直接吃既有的 `.kr-go`（珊瑚）與 `.kr-ghost`（外框）樣式，`sheetWho()` 依 `keyring.device.userId`（上次解鎖的人）決定誰用 `.kr-go`；沒有上次紀錄時**全部用 `.kr-ghost`**，不要亂猜。

**驗收線**：所有觸控目標 ≥44px、密碼 input `font-size:16px`（iOS 不自動放大）、第一步 sheet 高度 ≤280px、頭像底色與白底對比不得高到搶過旅程封面（肉眼比：sheet 打開時最亮的東西應該仍是後面的封面）。

---

# 解鎖畫面 v3「公版」（2026-08-20・lab-ux）

> Demo：`demo/unlock-v3.html`（單檔零依賴、雙擊即開；同畫面並排手機 375 與電腦 1280）。
> 狀態：**待 Benson 試玩拍板**。拍板後 lab-dev 才改 `client/keyring-unlock.js`。
> **狀態機、流程、記住裝置、密碼顯示切換、唯讀入口、加解密全部不動**——這一輪只換版面與視覺。
> 這一段推翻 v2.1 的部分決策（見 §7），改的時候要一起更新 travel-planner／recipe-book 的 CLAUDE.md。

## 1. 這次要解的三件事

1. **醜**：解鎖畫面在食譜本裡看起來不是「這個 App 的東西」，也不是「一個獨立的東西」，卡在中間。
2. **不統一**：底部 sheet 的尺寸／密度會被每個宿主的內容影響，兩個 App 看起來就是兩樣。
3. **半套主題化**（QA 抓到的技術根因）：`.kr-chip`／`.kr-why`／`.kr-err` 底色寫死粉色系（`#fff1ef`／`#fbeeee`），字卻吃 `--acc`。橘色 App 一接上去就是粉底＋橘字。**只要模組還有「一半吃變數、一半寫死」的顏色，接第 N 個 App 就會再壞一次。**

## 2. 定案：B 案——自成一格的一層，所有 App 長得一模一樣

**採 B（全螢幕暖夜色，跨 App 完全相同），不採 A（吃各 App 主色）。** 四個理由：

1. **A 案的「統一」只到結構，B 案才是公版。** Benson 要的是「每個 web app 都套一樣的」，A 案每接一個新 App 都要調一次色，而且調不好就是這次的粉底＋橘字。
2. **B 案從根上殺掉半套主題化**：滿版層一個 App 變數都不讀，就沒有「吃到一半」這種狀態。
3. **語意對**：解鎖是「進 App 之前」的一層（像作業系統的登入畫面、Netflix 的選人頁），它本來就不該屬於任何一個 App 的視覺語言。v2 診斷出的「語意借錯層」在 A 案裡永遠有復發風險。
4. **對比與可及性自己保證**：深底＋暖白字是模組自己控制的，不必猜宿主會給什麼底色。

**但不是 Netflix 的純黑。** 底色用 **暖墨咖啡** `#1a1510`／`#1e1913` ＋頂部一層極淡暖光，跟他所有 App 的暖米白是同一個色溫的兩端（白天／關燈）。看起來是「同一家人，只是燈關了」，不是外來的黑箱。

**滿版底層刻意不做到 100% 不透明**：`rgba(26,21,16,.955)` ＋ `backdrop-filter:blur(18px)`。後面的 App 內容還隱約看得到形狀但看不清細節 —— 同時滿足「像 Netflix 的滿版」與 v1 的核心洞見「你沒有離開 App」。不支援 backdrop-filter 的瀏覽器就是一片暖墨底，不會壞。

**App 的身分靠文字不靠顏色**：左上角一行 `🧭 旅途手帳`（13px、次要色）。零調色成本、零撞色風險。

## 3. 顏色歸屬（這是根治半套主題化的規則本身）

| 層 | 誰決定顏色 | 規則 |
|---|---|---|
| 滿版解鎖層（`#kr-full` 內全部） | **模組**，寫死 | **一個宿主變數都不准讀**。連 `var(--acc, fallback)` 都不准，因為 fallback 一樣會造成半套 |
| 使用者頭像 | **鑰匙圈**（`themes` 那五組漸層） | 顏色代表「人」，不代表 App。同一個人在每個 App 都是同一個顏色 |
| 身分藥丸 `.kr-chip`（住在 App 畫面裡） | 模組定中性底，**只有前景吃 `--acc`** | **鐵律：主色只准上前景（文字／圖示／1px 框），底色永遠是模組固定的中性色。** 沒接變數時 fallback 也照樣好看 |

模組內部用 `--krs-*` 前綴的變數當常數（定義在 `#kr-full` 上）。**這些是模組自己的，宿主不准設、模組也不讀宿主的同名變數。**

```
--krs-ink:#f7f2e8   --krs-mut:#a49a8c   --krs-line:rgba(255,255,255,.12)
--krs-face:rgba(255,255,255,.055)       --krs-facehi:rgba(255,255,255,.10)
--krs-btn:#f6efe1   --krs-btn-ink:#241e17
--krs-err-bg:rgba(255,120,105,.14)  --krs-err-line:rgba(255,120,105,.30)  --krs-err-ink:#ffb3a6
--krs-warn-bg:rgba(255,198,120,.13) --krs-warn-line:rgba(255,198,120,.28) --krs-warn-ink:#f2d5a1
底：rgba(26,21,16,.955) + blur(18px)
頂部暖光：radial-gradient(120% 70% at 50% -14%, rgba(255,203,140,.16), transparent 62%)
```

**要刪掉的寫死顏色**（就是這次的病灶）：`#fff1ef`（.kr-why）、`#fbeeee`（.kr-err／.kr-danger）、`#f3eee4`（.kr-chip.on）、`#fff6e3`／`#f2dcae`（.kr-warn）、`#fbf9f4`／`#efe9dd`（.kr-tile）、`#e4ddcf`（.kr-grab，元件本身也刪）。

**新 App 接入要設定什麼：什麼都不用設。** 想讓身分藥丸的「點我解鎖」跟著 App 走，就設一個 `--acc`；不設就用模組預設 `#c1553f`。**這是唯一一個可選的鉤子。**

## 4. 版面

三段式 flex column，**全篇不用 `position:fixed` 的子元素**（鍵盤處理靠這個，見 §6）。

```
┌ .kr-top ───────────────────────────┐  flex:0 0 auto
│ 🧭 旅途手帳              ✕(46px)   │  （第二步左邊換成「‹ 換一個人」）
├ .kr-main > .kr-mid ────────────────┤  flex:1 1 auto; overflow-y:auto
│                                    │  .kr-main 也是 flex column，
│         （內容垂直置中）            │  .kr-mid 用 flex:1 0 auto ⇒
│                                    │  內容短時置中、內容長時撐開可捲、不會截頂
├ .kr-foot ──────────────────────────┤  flex:0 0 auto; border-top
│      👀 先看看就好                  │
│  不用密碼也能看，只是不能改東西      │
└────────────────────────────────────┘
```

### 4-1 選人（`sheetWho` → `drawWho`）

- 標題 `誰要編輯？`（25px/800，桌機 32px 置中）。**不要用「誰在用？」**——那句話暗示「你必須是其中一個」，「誰要編輯」才把「只想看」講成不用回答的問題。
- 副標 `選自己、輸一次密碼，這台裝置就記住了。`
- 理由條 `.kr-why`（被寫入動作叫出來時）：`要「規劃新旅程」得先解鎖，選一下你是誰就好。`
- 人物磚 `.kr-tile`：flex wrap、`justify-content:center`、gap 10。
  - 手機：`flex:0 0 calc(50% - 5px)`、`min-height:126px`、頭像 66px。
  - **超過 6 人（`.kr-grid.many`）手機改 3 欄**、磚 112px、頭像 54px（8 人一屏看得完，這就是滿版的優勢所在）。
  - 桌機（`min-width:900px`）：磚固定 `152px × 150px`、頭像 76px，wrap 置中；1 人／2 人／8 人都不會荒。
- **頭像一律圓形＋滿彩度漸層**（見 §7 為什麼可以改回滿彩度）。`box-shadow` 用 `0 2px 10px rgba(0,0,0,.18)` ＋ `inset 0 0 0 1px rgba(255,255,255,.16)`。
- 名字 `.kr-nm` 14.5px/700，`-webkit-line-clamp:2` ＋ `word-break:break-word`（長名字不爆版）。
- **同名分辨（已知缺陷的解法）**：`.kr-hint` 12px 次要色小字，內容 = `u.hint`（後台新欄位，選填，例「手機那支」）；沒有 hint 但**名字在名單裡重複**時，退而顯示 `u.id`（ASCII slug，本來就唯一）。名字不重複又沒 hint 就不顯示。**這條純前端、不用資料遷移**；後台加 `hint` 欄位是加分項、可另開工單。

### 4-2 輸密碼（`sheetPw` → `drawPw`）

- 左上 `‹ 換一個人`（多人時），右上 ✕。
- 置中身分區 `.kr-id`：66px 圓頭像 → `嗨，女友`（21px/800）→ `輸入密碼就可以編輯`（有 hint 時前綴 `手機那支・`）。
- `.kr-field input`：**font-size 16px**、min-height 54、`padding:0 56px 0 16px`、底 `--krs-face`、框 `--krs-line`、字 `--krs-ink`、`::placeholder` 用 `--krs-mut` ＋ `opacity:1`（不設會被瀏覽器再打折變不可讀）。focus 框 `rgba(255,255,255,.45)`。
- `.kr-eye` 48×48。
- 錯誤條 `.kr-err`：第 1 次 `密碼不對，再試一次`；第 2 次起加第二行 `想不起來的話跟 Benson 說一聲，他那邊可以幫你換一組新的。`。**不做次數鎖定、不做倒數**（沒有伺服器，做了也是假的）。
- `記住這台裝置` ＋小字，**預設勾選**；勾選框 26px、checked 時填 `--krs-btn`（暖白）＋深色勾。
- 主鈕 `.kr-go`：**暖白底 `#f6efe1` ＋ 深色字**，54px、16.5px/800。**刻意不是珊瑚／橘**——那是 App 的顏色，這一層沒有 App 的顏色。送出中換 `⟳ 解開中…` ＋ disabled。
- 原生 `<form>` ＋ `type=submit`（IME 組字不誤送）。

### 4-3 已解鎖／換人（`openIdentity`／`askSwitch`）

**也用滿版**，跟解鎖同一層語言（他要的是「統一介面」，不要一個滿版一個 sheet）。
- 身分頁：66px 圓頭像＋名字＋`這台裝置記住了你的鑰匙，可以編輯`；主鈕 `好，繼續用`（暖白）在上、`🔄 換人用`（ghost）在下。**這一頁沒有 peek bar**（已經解鎖了，「先看看」沒有意義），✕ 就是出口。
- 換人確認：`.kr-warn`（暖琥珀，dark-safe）＋ `清掉，換人`（danger）／`先不要`（ghost）。

### 4-4 抓不到鑰匙圈（離線）

滿版置中：`🌧️` 42px ＋ `現在拿不到鑰匙圈` / `可能是網路的關係。` / **`你已經看得到內容，只是暫時不能編輯。`**（這句一定要有——告訴他沒有壞掉）＋ `↻ 再抓一次`（ghost）。**peek bar 照樣在。**

### 4-5 只有一個使用者

沿用 v1 規則：`draw()` 發現只有 1 人就直接跳 `pw` 步驟、不顯示「‹ 換一個人」，但**仍顯示他的頭像與名字**。滿版下這一屏會很空 → 靠 `.kr-mid` 垂直置中 ＋ `.kr-wrap.narrow`（380／桌機 400）撐住，實測不空。

## 5. 「先看看就好」怎麼在滿版下不被犧牲（硬性限制 1）

**兩個出口，其中一個是版面的固定成員：**

1. **底部 `.kr-foot` 常駐條**：`border-top` 分隔、全寬可點、62px 高、主文字 15.5px/700 `👀 先看看就好` ＋第二行 12.5px `不用密碼也能看，只是不能改東西`。它跟人物磚之間有明確的線，是畫面上**第二個焦點區**，不是角落的小連結。**每一屏（選人／輸密碼／離線）都要有。**
2. **右上 ✕**（46px），關掉＝回到剛才在看的畫面。

加上標題改成「誰**要編輯**？」，整屏的 framing 從「門禁（你是誰）」變成「可選的升級（要改東西的話選一下）」。**這是滿版沒有變成鎖屏的關鍵，改文案等於改掉這個設計。**

首次進站 0.9 秒自動彈一次的規則不變（`introSeen`）。

## 6. safe-area 與鍵盤（硬性限制 3）

- **不用 `100vh`**。`#kr-full{height:100dvh; height:var(--kr-vh,100dvh);}`（`inset` 只寫 `left/top/right`，讓 height 生效）。
- `--kr-vh` 由 `visualViewport` 維護：

```js
function fitVH(){
  var vv = window.visualViewport, h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--kr-vh", h + "px");
}
// open() 時呼叫一次；listen visualViewport 的 resize 與 scroll，另加 window resize
```

  iOS 鍵盤彈出 → `--kr-vh` 縮小 → 整層跟著縮，內容不會被推到看不見的地方。

- **`.kr-foot` 是 flex item 不是 `position:fixed`** ⇒ 鍵盤彈出時它自然停在鍵盤正上方，不會浮在鍵盤上、也不會被推出畫面。**這是刻意的，不要「優化」成 fixed。**
- safe-area：
  - `.kr-top` → `padding-top:calc(10px + env(safe-area-inset-top))`、左右 `max(14px, env(safe-area-inset-left/right))`
  - `.kr-foot` → `padding-bottom:calc(6px + env(safe-area-inset-bottom))`（桌機 10px）
  - `.kr-mid` 左右同樣吃 `max(18px, env(...))`（橫置時瀏海側不會壓字）
- `open()` 時 `document.body.style.overflow="hidden"`，`close()` 還原（別用 `position:fixed` 鎖 body，會丟捲動位置）。

## 7. 相對 v2.1 刻意反轉的兩點（別當 bug 修）

| v2.1 規則 | v3 | 為什麼可以反轉 |
|---|---|---|
| 「別再把 `grad()` 用回頭像」，一律用 20% tint | **滿彩度漸層回來了** | v2.1 的理由是「滿彩漸層在這個 App 是一趟旅程的語言，會跟旅程封面撞」。**v3 的解鎖層是獨立的深色滿版，畫面上根本沒有旅程封面可以撞。** 而且深底上需要彩度才看得見人。另外加一道保險：**頭像一律圓形，旅程／菜色卡一律圓角矩形**——用形狀分語意，顏色就不必退讓 |
| 身分藥丸的 `.kr-dot` 吃 tint | **`.kr-dot` 也改滿彩度、改圓形，22px** | 同一個人在解鎖畫面與藥丸要是同一個顏色；22px 圓點面積極小，不構成競爭 |

反過來，**v2.1 的「提權不准綁宿主結構」這條完全保留並強化**（見 §8）。

## 8. CSS 權重（硬性限制 2）

- **滿版層內**：一律寫 `#kr-full .kr-x{}`（1,1,0）。這綁的是**模組自己的 id**，不是宿主結構，複製到任何 App 都成立，而且比宿主任何 class 選擇器都高。
- **滿版層外**（只有身分藥丸）：`.kr-chip.kr-chip{}`（0,2,0），同一個 class 寫兩次。
- **絕對禁止**：`.home-foot .kr-chip`、`#app .kr-chip` 這種綁宿主 DOM 的寫法。
- 元素級 reset 也要有，且要靠 `#kr-full` 提權：

```css
#kr-full *{box-sizing:border-box;}
#kr-full button{font-family:inherit; font-size:15px; border:none; background:none; cursor:pointer;
                color:inherit; padding:0; margin:0; line-height:1.4; text-align:inherit;
                -webkit-appearance:none; appearance:none;}
#kr-full input{font-family:inherit; -webkit-appearance:none; appearance:none;}
```

  `.kr-chip` 自己要鎖死 `font-family / font-size / font-weight / line-height / letter-spacing / margin / padding / appearance / box-shadow / text-align`（它站在宿主 footer 裡，宿主什麼都可能滲進來）。
- 樣式注入時機仍是 `init()`，不是第一次 `paint()`（藥丸每次進站都在）。

## 9. class 對照表（lab-dev 照這張改）

| 舊 | 新 | 動作 |
|---|---|---|
| `#kr-layer` `.kr-backdrop` `.kr-sheet` `.kr-grab` | `#kr-full` ＋ `.kr-top`／`.kr-main`／`.kr-mid`／`.kr-wrap`／`.kr-foot` | 換掉（sheet 與 grab bar 整個移除） |
| `.kr-head` `.kr-head h3` | `.kr-top` ＋ `.kr-h`（標題移進 `.kr-wrap`，不在頂欄） | 換掉 |
| `.kr-x` `.kr-back` | 同名保留 | 改樣式（深色版） |
| `.kr-why` `.kr-sub` | 同名保留 | 改樣式，**去掉 `#fff1ef`** |
| `.kr-grid` `.kr-tile` `.em` `.kr-tx` `.nm` `.go` | `.kr-grid`／`.kr-tile`／`.kr-av`／`.kr-tx`／`.kr-nm`／`.kr-hint`（`.go` 箭頭刪除） | 重寫成磚狀；新增 `.kr-grid.many`、`.kr-hint` |
| `.kr-peek` `.kr-peek-link` | `.kr-peek`（單一按鈕，含 `<b>` ＋ `<span>` 兩行） | 合併重寫 |
| `.kr-face` `.kr-title` `.kr-saytxt` `.kr-id-face` | 全部收斂成 `.kr-id` ＋ `.kr-av` | 刪除多餘的 |
| `.kr-field` `.kr-eye` `.kr-err` `.kr-check` `.kr-box` `.kr-lb` `.kr-go` `.kr-ghost` `.kr-danger` `.kr-spin` `.kr-warn` `.kr-empty` | 同名保留 | 只改樣式（深色版），JS 不動 |
| `.kr-chip` `.kr-dot` | 同名保留 ＋ 新增 `.kr-cta` | 中性底＋主色只上前景；dot 改圓形滿彩 |
| — | `.kr-stack`（垂直按鈕組，gap 10） | 新增 |

**JS 只要動這些**：`ensureDom()` 建 `#kr-full`（不是 layer+backdrop+sheet）、`paint()` 改成 `paint(topHtml, bodyHtml, footHtml, focusId)` 三段、`sheetWho()`／`sheetPw()`／`openIdentity()`／`askSwitch()` 的 template、新增 `fitVH()` ＋ `hintOf(u)`、`chipHtml()` 換 markup。**狀態機、`submit()`、加解密、`refreshFromRing()`、`writeDevice()`、`maybeIntro()` 一行都不要動。**

## 10. 驗收線（lab-qa 照這個退件）

1. **同一份模組在旅途手帳與食譜本裡，解鎖畫面的 computed style 必須逐項相同**（底色、字色、按鈕底色、圓角）——這是「公版」的機器定義。差一項就是半套主題化復發。
2. `#kr-full` 子樹內**不得出現任何 `var(--acc`／`--acc-deep`／`--bad`／`--ink`／`--muted`／`--line`／`--card`／`--bg`**。用 `grep` 驗，不是用眼睛。
3. 把模組丟進一個**沒設任何 CSS 變數的空白頁**，解鎖畫面要完全正常（demo 的「新 App（零設定）」情境就是這個測法）。
4. **每個可互動元素實際量 computed style**（背景色、文字色、尺寸、圓角）——v2.0 那顆透明的解鎖鈕就是這樣漏掉的。特別量：`.kr-go` 的 `background-color` 必須是 `rgb(246,239,225)` 不是 `transparent`；`.kr-chip` 的 `background-color` 必須是 `rgb(246,242,234)`。
5. 觸控目標 ≥44px：✕、👁、`.kr-back`、`.kr-peek`、`.kr-tile`、`.kr-chip`、勾選列。
6. `#kr-pw` 的 `font-size` 必須是 `16px`。
7. **每一屏（選人／輸密碼／密碼錯／離線）都要看得到「先看看就好」**。少一屏就退件。
8. 375×667（小 iPhone）8 人不截頭、可捲到底；1280 寬 1 人不空洞。
9. 鍵盤彈出時（或用 devtools 把 viewport 高度壓到 380px）解鎖鈕與 peek bar 仍在可視區內。

## 11. 想請 Benson 拍板

1. **B 案（推薦，demo 預設）vs A 案**——demo 上方切「配色方案」可以直接對照。
2. **身分頁（已解鎖點藥丸）也用滿版**（推薦，統一）——還是那一頁維持小小的就好？
3. **後台要不要加一個選填的「備註」欄位**（例：「手機那支」）解決同名分不出來？不加的話會顯示英文 id，能用但沒那麼漂亮。

---

# 解鎖畫面 v4 視覺・lab-ux（2026-08-21）

> Demo：`demo/unlock-v3.html`（雙擊即開）。**這一輪只動 demo，`client/keyring-unlock.js` 一個字都沒改**，等 Benson 拍板後才由 lab-dev 搬。
> 這一段是 v3 的**增修**，不是取代：v3 §2~§5、§7~§9 的所有決定（B 案深色公版、顏色歸屬、三段式版面、「先看看就好」三件事、class 對照表）全部有效。
> 起因是 Benson 兩句話：①「輸入密碼的時候他下面會是白色的，很醜」②「加一點解鎖動畫，現在有點死板、有點不高級」。

## 1. 白色是怎麼來的（診斷，已在 demo 重現）

`#kr-full` 是 `position:fixed; left/top/right:0; height:var(--kr-vh)`，**沒有 `bottom`**。兩條路徑各自會露白：

| # | 情境 | 為什麼露白 | 白會在哪 |
|---|---|---|---|
| A | 鍵盤滑上來的那 250~300ms | `visualViewport` 的 resize 立刻把 `--kr-vh` 從 800 縮到 407，但鍵盤還在路上 ⇒ 中間那段**沒有任何元素去畫** | 層底下、鍵盤上面，一閃而過 |
| B | iOS 對焦 input | Safari 把 **layout viewport 往上捲**（`visualViewport.offsetTop` 變成 40~60），而 `position:fixed` 是釘在 layout viewport 的 ⇒ 整層在螢幕上往上跑那麼多 | 層底下一條，**不會消失**，而且頂欄被切掉 |

B 是主兇（「一直是白的」）。`offsetTop` 目前完全沒被讀。

**死路（別再試）**：不能用 `position:fixed` 的子元素去補下面那塊 —— `#kr-full` 有 `backdrop-filter`，會成為 fixed 子孫的 containing block，逃不出去。

## 2. 修法（兩行 CSS ＋ 兩行 JS）

**2-1 把「層以外」也畫掉 —— `#kr-full::before` 加一個大 spread 的實色 `box-shadow`**

```css
#kr-full{ --krs-bleed:#191510; }              /* 新增常數 */
#kr-full::before{
  content:""; position:absolute; inset:0; pointer-events:none;
  background: radial-gradient(120% 70% at 50% -14%, rgba(255,203,140,.16), rgba(255,203,140,0) 62%),
              radial-gradient(150% 95% at 50% 116%, rgba(0,0,0,.16), rgba(0,0,0,0) 60%);
  box-shadow: 0 0 0 100vmax var(--krs-bleed);  /* ← 就是這行 */
}
```

- **不動 DOM、不動 `applyDensity()` 的量測基準**（`::before` 是 absolute，不參與 flex 版面）。
- `100vmax` 是**陰影擴散半徑**不是尺寸，不需要跟著鍵盤變，跟「不可用 100vh」那條無關（那條講的是 layer 的 height）。
- `--krs-bleed` 刻意比層底**再深一點**（層合成後約 `rgb(36,31,26)`，bleed 是 `#191510`）：讀起來像「層的陰影往外收」，而不是一條接縫。⚠️ **底部那道 vignette 不要調深**（現在 `rgba(0,0,0,.16)`），調到 .30 以上就會跟 bleed 對出一條看得見的線。
- 不支援 `backdrop-filter` 的瀏覽器照樣正常（bleed 是實色，跟 blur 無關）。

**2-2 把層貼回可視區 —— 讀 `visualViewport.offsetTop`**

```css
#kr-full{ top:var(--kr-top,0px); }   /* 原本是 top:0 */
```
```js
function fitVH(){
  var vv = global.visualViewport;
  var h  = vv ? vv.height : global.innerHeight;
  var t  = (vv && vv.offsetTop) ? vv.offsetTop : 0;                    /* 新增 */
  if (h) document.documentElement.style.setProperty("--kr-vh", h + "px");
  document.documentElement.style.setProperty("--kr-top", t + "px");    /* 新增 */
  applyDensity();
}
```
`fitVH` 已經掛在 `visualViewport` 的 **resize ＋ scroll**（iOS 捲動時是 scroll 在動），不用加新的 listener。

**2-3 `applyDensity()` 改用 `offsetHeight`**

```js
if (layer.classList.contains("kr-leave")) return;   /* 離場動畫進行中不重算 */
var h = layer.offsetHeight || layer.getBoundingClientRect().height;
```
理由：`getBoundingClientRect()` **會把進／離場的 `scale()` 算進去**（實測進場時量到 636 而不是 624），高度剛好卡在門檻上時會在鍵盤彈出的瞬間閃一次密度切換。`offsetHeight` 只回版面高度。

**不准動的**：`.kr-foot` 維持 flex item（鍵盤彈出時自然停在鍵盤上方）；`.kr-short/.kr-tiny/.kr-micro` ＋ `ResizeObserver` 這套整組保留；不可用 `100vh`；不可用 `@media(max-height:…)` 做密度。

## 3. 質感（非動畫的部分，這一段比動畫重要）

原則：**深底上的平面色塊看起來就是「黑框框」**。加一道上緣高光＋一層外投影，材質就出來了，成本是零。

⚠️ **鐵律：`background-color` 與 `background-image` 一定要分開寫，禁止用 `background` 簡寫接漸層。** 用簡寫會把 computed 的 `background-color` 變成 `transparent`——那正是 v2.0 那顆隱形解鎖鈕的死法，而且 lab-qa 量的就是 `background-color`。（已實測：加了 sheen 之後 `.kr-go` 的 `background-color` 仍是 `rgb(246,239,225)`。）

| 元素 | 改動 |
|---|---|
| `.kr-tile` | `background-color:var(--krs-face)` ＋ `background-image:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,0) 62%)` ＋ `box-shadow:inset 0 1px 0 rgba(255,255,255,.07), 0 2px 6px rgba(0,0,0,.16)`；hover 換成 `.10` 高光＋`0 6px 18px rgba(0,0,0,.22)`；`:active` `scale(.965)` |
| `.kr-av` | 加 `position:relative`（給成功光圈用）；shadow 改 `0 4px 14px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.30), inset 0 0 0 1px rgba(255,255,255,.14)` ⇒ 從貼紙變成有受光的球 |
| `.kr-go` | 加 `background-image:linear-gradient(180deg,rgba(255,255,255,.60),rgba(255,255,255,0) 58%)` ＋ `box-shadow:0 6px 20px rgba(0,0,0,.30), inset 0 -1px 0 rgba(0,0,0,.05)`；`:active{transform:scale(.985)}` |
| `.kr-field input` | focus 從「只換框色」加成 `box-shadow:0 0 0 3px rgba(255,255,255,.07)` 柔光圈；三個屬性都給 transition |
| `.kr-x` / `.kr-back` / `.kr-eye` / `.kr-peek` / `.kr-ghost` / `.kr-danger` | 補 `:active`（手機沒有 hover，原本按下去完全沒回饋）＋ 對應 transition |
| `#kr-full::before` | 多一層底部 vignette（見 §2-1） |
| 新增常數 | `--krs-bleed:#191510`、`--krs-ease:cubic-bezier(.22,.9,.3,1)` |

`.kr-why`／`.kr-err`／`.kr-warn`／`.kr-box`／`.kr-ghost`／`.kr-danger` 的 `background:` 一律改寫成 `background-color:`（值不變，只是為了讓 QA 量得到、也避免以後有人加 image 時踩到同一顆雷）。

## 4. 動畫

四個時機，每個都有**目的**，不是裝飾。全部走 `--krs-ease: cubic-bezier(.22,.9,.3,1)`。

### 4-1 觸發時機的判定（這是整套的關鍵，先講）

`paint()` 每次狀態變動都會重建整個 `innerHTML`——**如果進場動畫每次都跑，按一下顯示密碼、打錯一次、送出中，整屏都會重新蹦一次，那才是真的廉價。** 所以由 `paint()` 自己判斷，呼叫端一行都不用改：

```js
var lastKey = null;
function screenKey(){ return ui.view+"|"+ui.step+"|"+(ui.userId||"")
                     +"|"+(ring?"r":(ringErr?"e":"l")); }   /* 名單：ready／error／loading */

/* paint() 開頭 */
var k = screenKey();
var mode = layer.hidden ? "open" : (k !== lastKey ? "step" : "");
lastKey = k;
if (reducedMotion()) mode = "";
layer.className = (mode==="open" ? "kr-a-open" : mode==="step" ? "kr-a-step" : "");
```

- `open`＝這一層剛打開（整套進場）
- `step`＝換屏（選人↔輸密碼、身分頁、換人確認）→ 只有中段動，頂欄與底條**留在原地不動**
- `""`＝同一屏重繪（顯示密碼／錯誤／送出中）→ **完全不動**

**判定出來的實際例子（別當 bug 修）**：

| 操作 | 判定 | 為什麼 |
|---|---|---|
| 藥丸／守門處叫出解鎖畫面 | `open` | 層本來是 `hidden` |
| 選人 → 輸密碼、`‹ 換一個人` | `step` | 同一層、換了一屏 |
| 顯示密碼／打錯重繪／送出中／`✓ 解開了` | `""` | 同一屏的狀態變化（`ui.tries`／`show`／`busy`／`done` 刻意不進 key） |
| 身分頁 → `🔄 換人用` 確認屏 | `step` | `ui.view` 從 `id` 變 `switch` |
| **`doSwitch()`（「清掉，換人」）後回到選人屏** | **`step`（不是 `open`）** | 換人確認屏當下還開著、層沒有 `hidden` 過，所以是一次換屏而不是重新進場。**這是對的**：使用者眼裡是同一層裡換了一屏，中途沒有「整層再蹦一次」。（lab-qa 觀察 O-1，判定為改對了；下一個人不要把它「修」回 `open`。） |
| 名單從「正在拿鑰匙圈…」變成人物磚／離線錯誤屏 | `step` | key 裡的名單狀態（`r`／`e`／`l`）變了 |

⚠️ `close()` 要把 `lastKey = null`，否則關掉再開會被判成 step。
⚠️ `layer.className` 被整個覆寫 ⇒ **密度 class 會被清掉**；`paint()` 尾端本來就有 `fitVH()`（內含 `applyDensity()`）會補回來，順序不可調換。
⚠️ 容器 class **只准在這裡整份指派**，其他地方一律不准 `classList.remove()` 局部拆——理由見 §4-7。
⚠️ **「同一屏連畫兩次」會把剛掛上去的 `kr-a-open` 清掉**（正本專屬的坑，demo 沒有）：`open()` 除了 `draw()` 之外還會 `fetchRing(false).then(draw)` 對一次名單，而 TTL 內的 `fetchRing` 是 `Promise.resolve` ⇒ 同一個 tick 內第二次 `paint()`，`screenKey` 沒變 ⇒ `mode=""` ⇒ 整份指派把 class 清空，**進場動畫等於沒播**（實測：class 空字串、磚的 `animation-delay` 0s）；網路慢一點則是播到一半被截斷。修法是**只有名單真的變了才重畫**（`listSig()` 比對 id/name/emoji/theme/hint），順便省掉一次沒必要的閃動。`retry()` 同理。

### 4-2 進場（`.kr-a-open`，總長 ~0.6s，最後一顆磚 0.39s 就定位）

| 元素 | 動畫 | 時間 |
|---|---|---|
| `#kr-full` | `kr-in`（opacity 0→1、scale 1.02→1） | .26s（沿用 v3，只改 ease） |
| `.kr-top` | `kr-fade` | .30s，delay .06s |
| `.kr-wrap > *`（標題／副標／理由條／form／stack） | `kr-rise`（opacity＋translateY 9px） | .34s，delay .05／.09／.13／.16s（`:nth-child`） |
| `.kr-wrap > .kr-grid` | **`animation:none`**（讓磚各自動） | — |
| `.kr-tile` | `kr-pop`（opacity＋translateY 10px＋scale .96） | .34s，`animation-delay:calc(.09s + var(--kr-i,0) * .032s)` |
| `.kr-foot` | `kr-rise` | .34s，delay .17s |

- 磚的序號用 **inline `style="--kr-i:N"`**（`sheetWho()` 的 `map` 加 index），這是這一輪唯一的 markup 變動。
- `.kr-grid` 的排除規則權重要對：寫成 `#kr-full.kr-a-open .kr-wrap > .kr-grid{animation:none;}`（1,3,0），而且**必須放在 `:nth-child` 那幾條之後**（同權重靠後者勝出）。

### 4-3 換屏（`.kr-a-step`，~0.33s）＋ 頭像共享形變

`.kr-wrap > *` 跑 `kr-rise` .26s（delay 0／.04／.07），磚 `kr-pop` .28s（step .026s）。頂欄與底條不動。

**選人 → 輸密碼**額外做一次 FLIP：把剛才那顆磚上的頭像位置記下來，換屏後套回新頭像再放掉，等於用動作講「你選的是這個人」。

```js
/* pick(id, ev) —— onclick 要多傳 event */
var t = ev && ev.currentTarget ? ev.currentTarget.querySelector(".kr-av") : null;
morphFrom = (t && !reducedMotion()) ? t.getBoundingClientRect() : null;

/* paint() 內，will = (mode==="step" && morphFrom) 時：
     el.innerHTML = …;
     if (will) { var idEl = el.querySelector(".kr-id"); if (idEl) idEl.classList.add("kr-nofx"); }
     el.hidden = false; fitVH();            // ← .kr-nofx 一定要在這行之前
     if (will) runMorph(); else morphFrom = null;
   ⚠️ 容器 class 只有 kr-a-open / kr-a-step，**沒有** kr-morphing。原因見 §4-7。 */
function runMorph(){
  var to = layer.querySelector(".kr-id .kr-av"), f = morphFrom; morphFrom = null;
  /* 量不到就安靜放棄：.kr-nofx 留著，那一屏只是沒有進場動畫，不會壞也不會事後補播 */
  if (!to || !f) return;
  var b = to.getBoundingClientRect(); if (!b.width) return;
  var dx = (f.left+f.width/2)-(b.left+b.width/2), dy = (f.top+f.height/2)-(b.top+b.height/2);
  to.style.transition = "none";
  to.style.transform  = "translate("+dx+"px,"+dy+"px) scale("+(f.width/b.width)+")";
  requestAnimationFrame(function(){
    to.style.transition = "transform .36s cubic-bezier(.22,.9,.3,1)";
    to.style.transform  = "none";
    /* 收尾只清自己設的 inline style，刻意不碰任何 class */
    setTimeout(function(){ to.style.transition=""; to.style.transform=""; }, 400);
  });
}
```
配套 CSS（**必須排在 `.kr-a-step` 那幾條之後**）：
```css
#kr-full .kr-wrap > .kr-id.kr-nofx{ animation:none; }            /* 頭像自己在飛，這一列不要再位移 */
#kr-full .kr-id.kr-nofx > div{ animation:kr-rise .28s var(--krs-ease) both .06s; }
```
`.kr-nofx` 由 `paint()` 在 `innerHTML` 之後、`fitVH()` 之前直接加在 `.kr-id` 元素上，**永遠不拆**（元素下次 paint 就整個換掉了）。
⚠️ **這個開關絕對不可以掛回 `#kr-full` 的容器 class**——理由與實測時間軸見 §4-7，那是 v4 第一版被退件的原因。
量不到（`!b.width`）就安靜跳過，不會壞。`backToWho()` 要 `morphFrom = null`。

### 4-4 打錯密碼

- `.kr-field` 加一次性 class `kr-shake` → `kr-nudge` .36s（左右 6→5→3→2px 遞減）。用 `ui.shake` 旗標：失敗分支設 `true`，`drawPw()` 開頭 `var sh = ui.shake; ui.shake = false;` 消費掉 ⇒ **只有真的打錯那一次會抖**，之後按顯示密碼重繪不會再抖。
- `.kr-err` 自己帶 `animation:kr-rise .22s var(--krs-ease) both`（每次重繪都是新元素，自然會跑）。
- 文案／次數規則不變（不做鎖定、不做倒數）。

### 4-5 解鎖成功（總共 ~0.65s，這是這輪投資最大的地方）

現在是「轉圈 → 突然消失 → toast」，等於沒有回饋。改成三拍：

1. **確認**（0~430ms）：`ui.done=true` 重繪 → `.kr-go` 換成 `✓ 解開了` ＋ class `kr-ok`（`kr-okpop` .38s 輕彈一下，且要寫 `#kr-full .kr-go.kr-ok, #kr-full .kr-go.kr-ok[disabled]{opacity:1}` 蓋掉 disabled 的變暗）；`.kr-id .kr-av` 加 class `kr-ok` → `::after` 一圈 `kr-ring` .55s 擴散淡出。
2. **退場**（430~660ms）：`closeLayer(true)` → 層加 `kr-leave kr-up` → `kr-out` .22s（opacity→0、scale→1.03，像門往前打開），`.kr-leave` 帶 `pointer-events:none` 讓底下馬上可點；用 timeout 收尾設 `hidden`。
3. **落點**：身分藥丸 `kr-chipin` .34s 彈出 ＋ `kr-chipglow` .9s 亮一圈（`box-shadow` 從 `0 0 0 0 rgba(120,96,60,.34)` 擴到 `0 0 0 15px` 透明）。`kr-new` **不用計時器拆**（見 §4-7）。
   **這一拍只呼叫一次 `chip(true)`，而且不排任何 JS 計時器**——標籤（狀態）立刻誠實，動畫（視覺）靠 CSS 的 `animation-delay` 自己等：

```js
closeLayer(true);
chip(true);                                        /* 立刻：標籤已是「⟨名字⟩・可以編輯」 */
toast("解開了，"+u.name+" 現在可以編輯 🎉");
```
```css
/* delay 期間 fill 往回填 from ⇒ 藥丸 opacity:0、pointer-events:none，
   層還在淡出的那 230ms 內完全看不見也點不到；層一消失才開始彈出。
   .24s = kr-out .22s ＋ closeLayer 收尾 230ms 取整。 */
.kr-chip.kr-chip.kr-new{
  animation: kr-chipin .34s cubic-bezier(.22,.9,.3,1) .24s both,
             kr-chipglow .9s ease-out .42s;
}
@keyframes kr-chipin{
  from{ opacity:0; transform:translateY(7px) scale(.94); pointer-events:none; }
  1%  { pointer-events:auto; }        /* 一開始播就恢復可點，不需要任何 JS 收尾 */
  to  { opacity:1; transform:none; pointer-events:auto; }
}
```

   這一版是**第三次改**才收斂的，前兩版錯在哪要記著（詳細通則見 §4-8、§4-9）：

| 版本 | 寫法 | 出的事 |
|---|---|---|
| v1 | `closeLayer(true); chip(true);` 同一個 tick | 藥丸在 `ui.done` 後 445ms 就起跑、層 1298ms 才消失 ⇒ **彈出的前 2/3 與光暈（1257ms 起）整段被還沒淡完的層蓋掉，等於白做** |
| v2 | `chip()` 立刻換標籤 ＋ `setTimeout(240)` 再 `chip(true)` 播動畫 | 標籤誠實了，但**藥丸被建立兩次**：靜止那顆從層半透明時（~110ms，層 opacity 0.679）就漸漸看得見，到 236ms 全亮，257ms 被第二次重建歸零、再淡入一次 ⇒ 看起來就是「閃一下」 |
| **v3（現行）** | **一次 `chip(true)`，時序交給 CSS delay ＋ `fill:both`** | 標籤全程誠實、動畫仍在層 `display:none` 之後起跑、沒有靜止藥丸先露臉、不必重建兩次、不必收尾 |

   實測（退場第 110ms）：文字 `Benson・可以編輯`、`opacity=0`、`pointer-events=none`、`elementFromPoint` **不會**命中藥丸（那個「看不見卻按得到」的窗也一併關掉了）；把動畫 `finish()` 之後 `opacity=1`、`transform` 回正、`pointer-events=auto`、`box-shadow=none`、`elementFromPoint` 命中 `BUTTON.kr-chip` ⇒ **完全靠 CSS 自己恢復**。整條成功路徑藥丸只建立 **1 次**。
   ⚠️ 光暈刻意用**中性暖色寫死**，不吃 `--acc`——藥丸的規則仍是「主色只准上前景（`.kr-cta` 的文字）」。

使用者自己關掉（✕／先看看就好）走 `closeLayer(false)` → `kr-outdn` .19s（scale .985，往後收），跟成功的「往前退開」方向刻意相反。

`open()` 前要先 `clearTimeout(leaveT); layer.classList.remove("kr-leave","kr-up"); layer.hidden = true; lastKey = null;`，否則離場途中被重開會卡住。

### 4-6 其他小回饋

`.kr-spin` 不變。`.kr-box` 的打勾 `kr-tick`（scale .4→1）.2s **只在使用者真的動到勾選框時才播**：

```css
#kr-full .kr-check input:checked + .kr-box::after{ content:"\2713"; }
#kr-full .kr-check input:checked + .kr-box.kr-tickable::after{ animation:kr-tick .2s var(--krs-ease) both; }
```
```html
<input type="checkbox" id="kr-rm" onchange="KR.tick(this)" …>
```
```js
tick: function(el){ var b = el.nextElementSibling; if (b) b.classList.add("kr-tickable"); }
```
原因：勾選框**預設就是打勾的**，而 `paint()` 每次重繪都產生新元素 ⇒ 不加這道閘的話，光是按「顯示密碼」勾勾就會跟著彈一次（實測按 9 次彈 9 次）。技術上每一次都是新元素的第一次播放、不算 §4-7 那種重播 bug，**但眼睛看得到，而那正是「廉價」的來源**。
`kr-tickable` 加上去就不拆，元素重繪時自然跟著死 ⇒ 重繪出來的預設勾選不彈、使用者自己按出來的才彈。實測：剛畫出來 `::after` 的 `animation-name` 是 `none`、重繪 5 次仍是 `none`、使用者按過之後變 `kr-tick`、再重繪一次又回到 `none`。

### 4-7 ⚠️ 動畫的「關閉開關」要掛在元素上，不可以掛在會被改動的容器 class 上

**這是 v4 第一版被退件的原因，lab-dev 千萬不要照抄那個寫法。**

第一版把「morph 期間 `.kr-id` 不要自己位移」寫成 `#kr-full.kr-morphing .kr-wrap > .kr-id{animation:none;}`，然後在 `runMorph()` 收尾的 `setTimeout(…,400)` 裡 `classList.remove("kr-morphing")`。實測時間軸（MutationObserver ＋ animationstart）：

| t | 事件 |
|---|---|
| 2ms | class＝`kr-a-step kr-morphing`，頭像開始飛，`.kr-id` 的進場被正確壓住 |
| 407ms | 收尾 `remove("kr-morphing")`，class 變成 `kr-a-step` |
| **415ms** | **`.kr-id` 從頭再播一次 `kr-rise`**，666ms 才結束（其他元素 339ms 前就全部結束了） |

Benson 回報的兩個症狀其實是**同一個 bug**：

1. **「卡卡的」**：畫面已經安定 → 停約 70ms → 身分列自己又動一次。（幀率無辜：靜止與動畫當下都是 144fps、long frame 0。）
2. **「頭像會閃一下」**：`kr-rise` 的第一格是 `from{opacity:0; transform:translate3d(0,9px,0)}`，重播的瞬間整排先「消失＋下移 9px」再淡回來。

**機制**：CSS 動畫是「規則命中就播」。容器 class 一被移除，原本被更高權重壓著的 `.kr-a-step .kr-wrap > *` 就**重新命中**那個元素，瀏覽器視為一個全新的動畫、從第 0 格開始。**把重播延後或縮短沒有用，閃還是會在**——必須讓那條規則從頭到尾都不可能命中。

**正解（已實作在 demo）**：把開關掛在元素身上，讓它跟元素同生共死。

```css
/* 排在 .kr-a-step 那幾條之後；(1,3,0) 打得贏 *:nth-child 的 (1,3,0) 靠的是源序 */
#kr-full .kr-wrap > .kr-id.kr-nofx{animation:none;}
#kr-full .kr-id.kr-nofx > div{animation:kr-rise .28s var(--krs-ease) both .06s;}
```
```js
/* paint()：innerHTML 之後、任何「會強迫算樣式／版面」的動作之前 */
if (will) { var idEl = layer.querySelector(".kr-id"); if (idEl) idEl.classList.add("kr-nofx"); }
```

`paint()` 每次都重建 `innerHTML` ⇒ `.kr-nofx` 跟著元素一起生、一起死，**沒有任何時機可以「拆掉它」**，規則自然不可能重新命中。`runMorph()` 因此**完全不碰 class**：收尾只清自己設的 inline `transform`／`transition`（transform 當下已經是 `none`，設空沒有視覺變化，也不會讓任何規則重新命中）；量不到就直接 `return`，那一屏只是沒有進場動畫，不會壞、也不會事後補播。

⚠️ **順序不可調換**：`.kr-nofx` 必須在 `fitVH()` **之前**標上去——`fitVH()` 會讀 `offsetHeight`＝強迫 layout，動畫在那一刻就定生死了。

**推廣成通則（搬正本時整份掃一次）**：

> 滿版層的容器 class **只准用「整份指派 `layer.className = …`」來改，不准用 `classList.remove()` 局部拆**。整份指派一定發生在 `paint()`（那一刻所有子元素同時換新，重新命中＝正常的第一次播放）；局部拆則發生在元素活著的時候，那就是重播。

依這條一起改掉的另外兩處（原本還沒出事，但寫法同型、遲早會犯）：

- `chip()`：原本 `setTimeout(…,1200)` 拆 `kr-new` → **改成不拆**。`chip()` 本來每次就重建 `innerHTML`；`kr-chipglow` 沒有 `forwards`，播完自己回到 `box-shadow:none`（已實測 `chipShadow=none`）。
- `closeLayer()`／`reopen()`：原本 `classList.remove("kr-leave","kr-up")` → 改成**先 `hidden = true`**（`display:none` 之後不可能有動畫跑）**再 `layer.className = baseCls()` 整份指派**。

**同一個坑的第二個現場：祖先換成 `<html>` 也一樣會犯。**（v4 第二版被退件的那條）
demo 的「動畫」控制原本用 `classList.toggle` 在活著的 `<html>` 上拆 `d-rm`／`d-plain`。實測：從「關掉」切回「完整動畫」時 `#kr-full` 在 8.9ms 觸發 `kr-in`、opacity 掉到 0 再淡回（**33 幀**）；從「只有淡入」切回「完整」則是 `form`(43.6ms) 與 `.kr-id > div`(64.5ms) 各重播一次 `kr-rise`。機制完全相同——**只要「動畫開關」是掛在某個祖先的 class 上，那個 class 在元素活著時被改動，就會重播**，`#kr-full` 與 `<html>` 沒有差別。
處置：切動畫模式時**整份重畫那一屏**（`reopen()` ＋ `draw()`），讓 class 與元素同生共死。實測修正後三種切換（完整→關掉、關掉→完整、只有淡入→完整）都是 `.kr-id` 節點換新（`idNodeReused=false`）、**在切換前就活著的節點上 0 次 animationstart**。

**唯一被允許保留的例外，以及它的代價**：`applyDensity()` 的 `classList.add/remove`（鍵盤／轉向隨時會改高度，拿不掉）。它現在無害是有條件的，條件要寫死在程式旁邊：
> **密度 class（`.kr-short`／`.kr-tiny`／`.kr-micro`）底下只准寫尺寸與間距，不准寫 `animation`／`transition`。**
（lab-qa 壓力測過：換屏動畫進行中連丟 15 次高度變化，replays = 0。但那是因為現在沒有動畫規則掛在密度 class 上，不是因為那樣寫本身安全。）

**姊妹條款**：§4-8（動畫改動的**副作用**落在狀態上）與 §4-9（多段式轉場的時序不要用 JS 計時器串）是同一家族，做退場／延後動畫時三條要一起看。

**量測陷阱（PM 踩過，記下來）**：這個 demo 跑在預覽面板裡時，**父層的 `requestAnimationFrame` 與 `setTimeout` 會被嚴重節流**（520ms 的取樣只拿到 1 幀、400ms 的 timeout 過了 1 秒還沒觸發）。驗動畫一律用 **iframe 自己的 `performance.now()` ＋ `MutationObserver`／`animationstart` 事件排序**，不要用父層計時器，否則會量出假的結論。

### 4-8 ⚠️ 為了視覺效果延後某件事之前，先問「這件事有沒有承載狀態」

**這是 v4 第三版被退件的原因。**

§4-5 把 `chip(true)` 從「與 `closeLayer(true)` 同一個 tick」推遲到 +240ms，純粹是為了讓彈出動畫不要被還沒淡完的層蓋住——**視覺上完全正確，但它同時把「身分藥丸的標籤」一起延後了**。而那顆藥丸不只是裝飾：

- 它的**文字就是系統狀態**（「🔒 只看看模式」vs「⟨名字⟩・可以編輯」）；
- 它在那 220ms 內**真的可以點**——因為 `.kr-leave{pointer-events:none}` 是刻意設計的（讓底下馬上可點）。

兩者相加＝**一個會說謊而且按得下去的按鈕**：使用者剛解鎖成功，按下去卻被丟回「誰要編輯？」。舊版（同 tick 重建）的說謊窗約 0ms，改動之後變成 220ms。

**通則**：
> 要延後的東西如果是**純視覺**（位移、縮放、透明度、光暈），延後隨便；如果它同時承載**狀態**（文字標籤、可用/不可用、可點擊區域、aria 屬性），就必須把它拆成「狀態立刻更新」＋「視覺稍後播放」兩件事。

實務上的檢查方式（QA 可直接沿用）：**在退場動畫進行中，對每一個「底下露出來、而且 `pointer-events` 允許點擊」的元素做一次 hit-test**，斷言它的文字與點擊行為都已經是新狀態。不要用計時器猜時間點，用 `animationstart(kr-out)` 當觸發點。

同型風險（目前沒犯，但要記著）：`.kr-go` 在 `ui.busy` 期間是 `disabled` 的，若哪天有人為了動畫把 `disabled` 的解除延後，就會開出「按鈕看起來還在轉圈但已經可以重複送出」的窗。

**後續**：本節的修法（立刻換標籤、延後播動畫）自己又生出兩個缺陷（R-3／R-4），最後是靠 §4-9 的結構性寫法一次解掉。兩節要一起讀。

### 4-9 ⚠️ 多段式轉場的時序，優先用 CSS `animation-delay` ＋ `fill:both` 表達，不要用 JS 計時器串

**這一節是三輪退件換來的，lab-dev 搬正本時請先讀完再動退場那段。**

解鎖成功那一拍同時要滿足三件事：**狀態標籤**要立刻誠實、**pointer-events** 要讓底下馬上可點、**動畫**要等層消失後才播。第一版把這三條時間線用 `setTimeout` 手工排在一起，結果是**每修一條就撞壞另一條**：

| 輪次 | 改了什麼 | 撞出什麼 |
|---|---|---|
| S-1 | 把 `chip(true)` 從同 tick 延後到 +240ms（讓動畫別被層蓋住） | **R-2**：藥丸標籤跟著延後 ⇒ 退場那 220ms 內它「說謊而且點得到」 |
| R-2 | 立刻 `chip()` 換標籤 ＋ +240ms 再 `chip(true)` 播動畫 | **R-3**：藥丸 onclick 從 `KR.open()` 變成 `openIdentity()`，而只有 `KR.open()` 會清 `leaveT` ⇒ 身分頁開了 120ms 又被舊計時器關掉<br>**R-4**：藥丸被建立兩次 ⇒ 先透出來、全亮、消失一兩幀、再淡入 |

病根不是個別 bug，是**「用 JS 計時器把互相耦合的時間線串起來」這個做法本身**。

**正解**：只做一次 DOM 更新（狀態立刻正確），把「什麼時候開始看得見」交給 CSS：

- `animation-delay` 表達「等多久」，
- `fill:both` 讓它在延遲期間**停在第 0 格**（`opacity:0` ⇒ 看不見），
- 需要「延遲期間不可點」就把 `pointer-events` 一起排進 keyframes（`from{none}` / `1%{auto}`），**動畫一開始播就自己恢復，不需要任何 JS 收尾**。

好處：時間線只有一條、寫在它作用的那個元素上、跟元素同生共死（呼應 §4-7），而且不會有「DOM 已經換了但 class 還沒跟上」的中間態（呼應 §4-8）。

**JS 計時器不可能完全消失的那一個（`closeLayer` 的收尾 `leaveT`）要配一條守衛。** 退場靠計時器把 `hidden` 設回 true，所以**任何「退場途中又要重新畫東西」的路徑都必須先取消它**。不要在每個入口各補一次（R-3 就是漏了 `openIdentity()` 那一個），**守衛放在 `paint()`**——每一屏都會經過那裡，將來新增入口不必記得補：

```js
function paint(top, body, foot, focusId){
  var el = layer();
  /* 退場途中（class 還有 kr-leave）或已經藏起來 ⇒ 先 reopen()（內含 clearTimeout(leaveT)），
     否則收尾計時器會在 230ms 後把剛打開的畫面關掉，變成「狀態機說開著、DOM 說關著」。 */
  if (el.hidden || el.classList.contains("kr-leave")) reopen();
  …
}
```
⚠️ 判斷條件**不可以只寫 `el.hidden`**：退場途中 `hidden` 還是 `false`，那條路就永遠不清計時器（R-3 的原形）。
守衛集中之後，`KR.open()`／`openIdentity()` 各自的 `reopen()` 就可以拿掉——**同一件事只留一個地方做**。

**驗收方式**：不要只驗單一時間點，要**掃退場全程**（QA 的做法：用 `animationstart(kr-out)` 當觸發點，逐幀取樣層與底下每個可互動元素的 `opacity`／`pointer-events`／文字／`elementFromPoint`）。R-4 就是「只看 dt=110 一個點會過、掃全程才現形」的典型。

## 5. `prefers-reduced-motion` 的降級行為

**CSS**（放在檔尾，一條總閘）：
```css
@media (prefers-reduced-motion: reduce){
  #kr-full{animation:none !important;}
  #kr-full *:not(.kr-spin){animation:none !important; transition:none !important;}
  #kr-full::before, #kr-full *::before, #kr-full *::after{animation:none !important;}
  .kr-chip.kr-chip{animation:none !important; transition:none !important;}
}
```
- `:not(.kr-spin)` 是刻意的：**讀取轉圈要留著**，那是狀態指示不是裝飾。
- 偽元素要單獨列（`*` 選不到），否則成功光圈還是會動。
- 所有 `kr-rise/kr-pop/kr-fade` 都是 `both` 填充 ⇒ `animation:none` 之後元素回到自然狀態（opacity 1、無位移），不會有東西不見。
- ⚠️ **`.kr-chip.kr-chip{animation:none !important}` 這條現在是承重的**：§4-5 讓 `kr-chipin` 帶 `.24s` delay ＋ `fill:both`，延遲期間藥丸是 `opacity:0; pointer-events:none`。萬一哪天 `kr-new` 在減少動態模式下被掛上去，就靠這條把 fill 一起關掉。已實測：強行掛上 `kr-new` ＋ 減少動態 ⇒ `opacity=1`／`pointer-events=auto`／`animation-name=none`，不會卡成隱形。（正常路徑本來就不會掛：`chip(fresh)` 在 `reducedMotion()` 時不加 `kr-new`。）

**JS**（四處，共用同一個判斷）：
```js
function reducedMotion(){
  return !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
```
1. `paint()`：`mode = ""`（不加任何進場 class）。
2. `pick()`：不記 `morphFrom` ⇒ 沒有頭像形變。
3. `closeLayer()`：直接 `hidden = true`，不跑離場；成功後的 430ms 等待改成 0（`✓ 解開了` 仍會 render 一幀，因為那是**狀態**不是動作）。
4. `chip(fresh)`：不加 `kr-new`。

功能與資訊**一項都不減**，只是全部瞬間到位。

## 6. demo 怎麼玩（給 Benson）

`demo/unlock-v3.html` 雙擊即開。控制列第二排（紅色的）分成兩種行為：

- **⌨ 鍵盤／iOS 捲動位移／底部露白 ＝ 即時切換，畫面不重來**（它們底下不掛任何 `animation`／`transition`）。這三個的用途就是「停在同一屏比對前後差異」，重畫會毀掉用途。
- **動畫 ＝ 會把當下這一屏整份重畫一次**（`reopen()` ＋ `draw()`，密碼欄已打的字會保留）。理由見 §4-7：動畫開關是掛在 `<html>` 上的 class，在活著的畫面上拆掉會讓規則重新命中而重播。而且使用者按「完整動畫」的意圖本來就是「我要看動畫」，重新進場正是他要的結果。


| 控制 | 用途 |
|---|---|
| ⌨ 鍵盤 | 全高／520／440／407／380／340 —— 直接改 iframe 內的 `--kr-vh`，同時把一個假鍵盤滑上來 |
| iOS 捲動位移 | 無／46px —— 模擬 §1 的 B 情境（真機上 fixed 元素被 layout viewport 帶著往上跑） |
| 底部露白 | 修好的／現況 —— **一鍵前後對照**，關掉就是 Benson 看到的那條白 |
| 動畫 | 完整／現況只有淡入／關掉 —— 最後一個等同手機開了「減少動態效果」 |

demo 這一輪也**補上了正本已經有、demo 卻缺的整組矮螢幕自適應**（`.kr-short/.kr-tiny/.kr-micro` ＋ `applyDensity()` ＋ ResizeObserver），不然鍵盤彈出時 demo 會演出跟真機不一樣的結果。

**demo 專用、lab-dev 不要搬進正本的東西**（原始碼裡都有標）：`#d-kbd` 假鍵盤、`postMessage` 那段與 `DEMO` 物件、`html.d-nofix / d-drift / d-plain / d-rm` 四條覆寫、`fitVH()` 裡 `DEMO.kbd ||` 那一段、`.mode-a`（A 案對照）。

## 7. 已經量過的（lab-dev 搬完要重量一次）

用 headless Chrome 對 travel／recipe／**完全沒設色票的空白 App** 三個宿主，各量 12 個元素 × 15 個屬性＝180 項 computed style：**三份逐項完全相同**（公版的機器定義成立）。另外：

- `#kr-full` 子樹內 `var(--acc|--ink|--muted|--line|--bg|--card|--bad)` 出現次數＝**0**；全檔 `--acc` 只出現一次，在 `.kr-chip .kr-cta` 的 `color`。
- `.kr-go` 的 `background-color` ＝ `rgb(246, 239, 225)`（加了 sheen 之後仍然是），`background-image` 是那道 sheen。
- `#kr-pw` 的 `font-size` ＝ `16px`；`.kr-x` 46×46、`.kr-peek` 62、`.kr-go`／`.kr-field input` 54、`.kr-box` 26（勾選整列 50）。
- 動畫觸發判定實測：開啟→`kr-a-open`（第 2 顆磚 delay `.122s` ＝ `.09 + 1×.032` ✓）；選人→容器 `kr-a-step`、`.kr-id` 拿到 `kr-nofx`、頭像拿到 inline transform（400ms 後只清 inline style、class 不動）✓；**按顯示密碼／打錯重繪→className 為空**（不重跑進場）✓；成功→`✓ 解開了`＋`kr-ring`→`kr-leave kr-up`→藥丸 `kr-chipin, kr-chipglow` ✓。
- 鍵盤情境實測（375×720、`--kr-vh` 407、offset 46）：修好的版本層剛好貼齊可視區、「先看看就好」停在鍵盤正上方、上下都沒有白；關掉修法則層整個上移 46px、頂欄被切、底下露出宿主的白卡片——與 Benson 描述一致。
- **退件複驗（動畫重播／閃爍）**：在 `http://localhost:4621` 用 **iframe 自己的計時器**取樣，點磚之後 11 個時間點（含原本重播的 395／410／425／450ms 窗口）`.kr-id` 的 `opacity` **全部是 1**、`animationName` **全部是 `none`**、`transform` 全部是 `none`；`animationstart` 一次都沒對 `.kr-id` 觸發；`#kr-full` 的 class 在 342ms 進入 `kr-a-step` 之後**再也沒有變動**（舊版在 407ms 有一次 remove、415ms 重播）。⇒ 卡頓與閃爍同時消失。
- 成功／關閉路徑同型掃描：`submit` 後兩次重繪 className 都是 `[]`（不重播進場）→ `kr-leave kr-up` → `hidden=true` 後才整份指派 className；藥丸 `kr-new` 留著但 `boxShadow` 已回到 `none`（`kr-chipglow` 無 forwards）；再開身分頁 → `kr-a-open`、關掉 → 加 `kr-leave` 不動 `kr-a-open`（不會讓子元素重新命中）。
- **`#kr-full` 不讀宿主變數的驗法，改用 live CSSOM 掃**（lab-qa 提供，建議以後沿用）：把注入的 stylesheet 用 `document.styleSheets` 走一遍 `cssRules`，對每條 selector 含 `#kr-full` 的規則檢查其宣告值有沒有 `var(--acc|--ink|--muted|--line|--bg|--card|--bad)`。實測**掃描總量 215 條**（頂層 197 ＋ `@media` 巢狀 18，巢狀規則要遞迴拆開才不會漏），其中 **selector 命中 `#kr-full` 的有 177 條，讀宿主變數 0 條**。**比 grep 原始碼好**：不會被註解、字串、被覆蓋掉的規則誤報。
- **退件複驗 R-1（切動畫模式造成重播）**：完整→關掉、關掉→完整、只有淡入→完整三種切換，`.kr-id` 節點都換新、切換前活著的節點上 0 次 animationstart；切到「關掉」時容器 class 為 `[]`（全部抑制），切回「完整」時為 `[kr-a-open]`（一次乾淨的重新進場）。
- **S-1 三拍不再重疊**：層消失 @1280ms → 藥丸起跑 @1290ms（當下 `layer.hidden === true`），`animation-name` 為 `kr-chipin, kr-chipglow`。
- **退件複驗 R-2（退場中藥丸說謊且可點）**：退場第 110ms 對藥丸中心 hit-test —— 文字已是 `Benson・可以編輯`、`elementFromPoint` 命中 `BUTTON.kr-chip`、點下去走 `KR.openIdentity()`（不再是 `KR.open()`）；`kr-chipin` 仍在層 `hidden=true / display=none / rectH=0` 之後才起跑；解鎖成功整條路徑的 replays＝`[]`（藥丸重建 2 次，都是新節點，沒有任何活著的節點因 class 變動而起播）。
- **退件複驗 R-3（退場中點藥丸被舊計時器關掉）**：退場第 110ms 點藥丸 → 走 `KR.openIdentity()`，之後 dt=300／500／900ms 三個取樣點層都還開著、`ui.open=true`／`ui.view="id"`／畫面是「Benson」，`ui.open !== layer.hidden` 的一致性檢查全過（修正前 dt=240ms 會被 `leaveT` 關掉，最終狀態是「狀態機說開著、DOM 說關著」）。
- **退件複驗 R-4（藥丸透出→全亮→消失→再淡入）**：整條成功路徑藥丸只建立 **1 次**（修正前 2 次）；退場第 110ms 量到文字已是 `Benson・可以編輯`、`opacity=0`、`pointer-events=none`、`elementFromPoint` 不命中藥丸；把動畫 `finish()` 之後 `opacity=1`／`transform` 回正／`pointer-events=auto`／`box-shadow=none`／`elementFromPoint` 命中 `BUTTON.kr-chip` ⇒ 全靠 CSS 自己恢復，零 JS 收尾。動畫參數實測 `kr-chipin(delay=240ms, dur=340ms, fill=both)` ＋ `kr-chipglow(delay=420ms, dur=900ms, fill=none)`。
- **S-2 打勾一次性**：剛畫出來 `::after` 的 `animation-name` = `none`、重繪 5 次仍是 `none`、使用者真的按過之後 = `kr-tick`、再重繪一次回到 `none`。
- 340px（最矮那一階）＋ 已打錯兩次：身分列／密碼欄／錯誤條／勾選／解鎖鈕／先看看就好**全部同時在畫面內**，沒有被切。

## 8. 拍板狀態

**已拍板（2026-08-21，Benson 試玩後）：第 1 項「要」、第 2 項「要」。** 第 3 項他還在試玩，先不動。

1. ~~**解鎖成功要不要「多花那 0.4 秒」**~~ → **要**。現在打對密碼會先看到 `✓ 解開了`＋頭像亮一圈，再退場，總共比舊版多約 0.43 秒。好處是「有沒有成功」變得明確、而且視線被帶到下面的身分藥丸；代價是每次解鎖多等一下下（但一台裝置通常只解一次）。不要的話砍掉這 0.43 秒即可，其他動畫不受影響。
2. ~~**選人時頭像「飛」過去要不要**~~ → **要**（實作在 §4-3，注意 §4-7 那個坑）。這是這一輪唯一比較「花」的動作，也是最有高級感的一個。如果覺得多餘，拿掉之後換屏就只剩淡入上移，其餘不變。
3. **（待定）鍵盤彈到最矮時（`.kr-micro`，約 340~460px）現在會讓掉三樣次要的東西**：理由條（「要規劃新旅程得先解鎖」）、錯誤條的第二行（「跟 Benson 說一聲…」）、「先看看就好」的第二行說明。主鈕、密碼欄、「先看看就好」主文字一定留著。要不要換一組讓法？
