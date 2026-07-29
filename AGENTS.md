# AGENTS.md — 給 AI 助理的專案規則

> 本專案由**多個 AI 工具共同維護**（Antigravity IDE、Claude Code、OpenAI Codex）。
> 這份檔案是所有工具共用的規則來源；`CLAUDE.md` 只是指向它的捷徑。
>
> **動手改任何東西之前，先讀完這一頁。** 下面每一條都對應真實發生過的事故。

---

## 0. 最高優先：不要做這三件事

### 0.1 絕對不要對版號做全域字串取代

升版時**只改 `package.json` 與 `package-lock.json`**，其他地方一律不要碰。

> **真實事故**：`17aa365`「bump version to v5.1.0」對 `docs/版本變更紀錄.md` 做了全檔版號取代，
> **95 筆歷史版號一次全毀**，變成 121 筆一模一樣的「v5.1.0」。內文交叉引用也跟著錯亂，
> 出現「v5.2.0 曾把容差放寬造成漂移（v5.2.0 修復）」這種同一版既造成又修復的句子。
> v5.2.0 升版時又重演了一次。已於 v5.2.2 從 git 還原。

文件裡的版號有兩種，意義完全不同：

| 型態 | 例子 | 可否修改 |
|------|------|---------|
| **歷史事實** | `## [v4.31.2]`、「v4.27 起的安裝版才開始壞」、「（v4.30 修）」 | **永遠不要動**。這是用來回答「這個坑是哪一版踩的」 |
| **當前版本** | 安裝檔檔名範例 | 只有這種需要跟著升版更新 |

各文件標頭**刻意不寫版號**——`package.json` 是唯一真相來源。不要「順手補上」。

### 0.2 不要在沒讀懂上下文時貼上大段內容

> **真實事故**：`README.md` 曾有第 54–88 行整段重複、bash code block 未閉合；
> `使用說明.md` 曾把桌面版的安裝步驟插進「網頁版」段落中間，讀者會照著做錯。

貼上前先確認插入點的前後文，貼上後**重讀一次該段落**。

### 0.3 不要用「有產出」當成「做對了」

驗證必須看**內容**，不是看有沒有報錯。詳見
[`docs/技術架構說明.md`](docs/技術架構說明.md) §0.6，那裡有兩個「驗證方法本身出錯」的真實案例。

---

## 1. 專案是什麼

Arctime 風格的多軌時間軸上字幕工具。**Vite + 原生 ES 模組（無框架）**，
以 `vite-plugin-singlefile` 打包成**單一 `dist/index.html`**，
同一份程式碼同時跑網頁版與 Electron 桌面版（以 `window.subtool` / `IS_DESKTOP` 分支）。

```
src/            前端 ES 模組（39 支）＋ decode/ 底下 4 支 WebCodecs 相關
electron/       主行程：ffmpeg / ffprobe / mpv / 檔案 I/O / 路徑白名單
docs/           說明文件（見下方「文件職責」）
tests/          vitest 單元測試（純函式與資料完整性）
font/<資料夾名>/ 自備字型，資料夾名＝UI 顯示名
```

---

## 2. 改程式碼前必讀：鐵律

**[`docs/技術架構說明.md`](docs/技術架構說明.md) §0「鐵律」是本專案最重要的一節。**
那些是「違反後會**靜默**壞掉」的不變量——畫面看起來正常、匯出卻是錯的。
本專案絕大多數 bug 都出在那幾條上，每一條後面都附了真實踩雷紀錄。

摘要（細節與案例請看原文，不要只讀這份摘要就動手）：

| # | 鐵律 |
|---|------|
| §0.1 | **三路一致**：HTML 預覽 ＝ mpv(libass) ＝ 匯出燒錄，三路只准吃 `substyle.js effStyle()` 的結果 |
| §0.2 | 字級縮放基準是**畫面高 ÷ PlayResY**，不是寬 |
| §0.3 | ASS 的 Fontname 要用**字型檔內部家族名**，不是資料夾名 |
| §0.4 | filtergraph 的 Windows 路徑要跳脫**兩層**（`C\\:/...`） |
| §0.5 | **時間域**：對外一律「時間軸時間」，播放器內部一律「來源時間」；轉換只准在序列層 |
| §0.6 | **「有產出」不等於「對」**——驗證要看內容 |
| §0.7 | 「有沒有顯示」只能看 **computed style**，不能看屬性 |
| §0.8 | 音訊素材／專案 bus／匯出聲道是三件事，不可混為一談 |
| §0.9 | 靜態圖片也是時間軸片段，不是播放器的一格畫面 |

另有 [`docs/FPS_時碼一致性.md`](docs/FPS_時碼一致性.md) 的 8 條時碼不變量——
**改任何牽涉時碼顯示、播放點、seek、逐格的程式碼前必讀**。
程式碼裡相關位置都標了可搜尋的 `FPS-SYNC`。

---

## 3. 文件職責（不要把內容寫到錯的檔案）

每份文件有**唯一且不重疊**的職責。要補內容時先確認該寫在哪一份，
**不要在兩個地方各寫一份**——那正是內容互相漂移的起點。

| 文件 | 職責 | 讀者 |
|------|------|------|
| `README.md` | 專案入口、快速開始、文件索引 | 所有人 |
| `docs/使用說明.md` | 操作手冊、快捷鍵、字幕格式 | 使用者 |
| `docs/開發與驗證.md` | 環境、npm 指令、發版流程、CDP 真機驗證、大檔人工驗證清單 | 開發者 |
| `docs/技術架構說明.md` | **鐵律**、模組架構、資料流、字幕樣式、WebCodecs、demux | 維護者 |
| `docs/Electron_維護手冊.md` | IPC 通道表、ffmpeg／mpv 整合、打包、排查表 | 維護者 |
| `docs/FPS_時碼一致性.md` | FPS／時碼的 8 條不變量與踩雷案例 | 維護者 |
| `docs/版本變更紀錄.md` | 版本歷史（**只新增最上面一筆**） | 所有人 |

**規則**：同一件事只在一處寫完整，其他地方用連結指過去。

---

## 4. 發版流程

```bash
npm run lint && npm test && npm run build   # ① 三關全綠才繼續
#                                            ② 桌面版真機驗證
# ③ 只改 package.json 與 package-lock.json 的版號（見 §0.1）
# ④ docs/版本變更紀錄.md 最上面新增一筆
npm run dist                                 # ⑤ → release/SUB Tool Setup X.Y.Z.exe
# ⑥ 實際安裝並確認 app 內顯示的版號
git add -A && git commit && git push origin main
# ⑦ 建立 GitHub Release，附上同一支 .exe
```

**變更紀錄請寫「為什麼」與「怎麼驗的」，不要只寫「修了 X」。**
這份檔案是本專案最有價值的交接資產——很多坑（字型家族名、filtergraph 跳脫、
CSS 蓋掉 `[hidden]`）都是靠它才沒有重踩。

> 本專案採 **main 直接發佈**。若工作樹混有其他工具或使用者未確認的修改，
> **不可直接 `git add -A`**，必須先確認哪些檔案屬於這一版。
> 多工具並行時這點特別重要——你看到的未提交變更可能不是你做的。

---

## 5. 提交訊息

**一律使用繁體中文撰寫 Git 提交訊息。**

寫清楚「改了什麼、為什麼」，不要只寫「修正 bug」。

---

## 6. 多工具協作注意事項

- **檔案可能在你讀取後被其他工具改掉。** 做大範圍修改前先 `git status`；
  編輯前若隔了一段時間，重新讀一次檔案內容。
- **不要假設工作樹是乾淨的**，也不要假設未提交的變更是你自己做的。
- **不要新增與既有規則牴觸的規則檔**（`.cursorrules`、`GEMINI.md` 等）。
  規則只寫在這一份 `AGENTS.md`，其他工具的規則檔請做成指向它的捷徑。

### 各工具實際會自動載入什麼

三個工具開場自動讀的檔案**完全不一樣**，但都已經接到這一份 `AGENTS.md`：

| 工具 | 怎麼讀到 `AGENTS.md` | 全域規則 |
|------|---------------------|---------|
| **Claude Code** | `CLAUDE.md` 第一行的 `@AGENTS.md` **import** | `~/.claude/CLAUDE.md` |
| **OpenAI Codex** | 原生就讀 `AGENTS.md` | `~/.codex/AGENTS.md` |
| **Antigravity** | 設定 `chat.useAgentsMdFile: true`（已實測生效） | `~/.gemini/GEMINI.md` |

**三者都不會自動讀 `README.md`。** 那是給人看的。

Antigravity 那條是實測的：開啟設定後，它的 **Customizations → Rules** 面板會列出
`Project · AGENTS.md`。要確認有沒有生效就去看那個面板。

> 曾經一度為了保險同時建了 `.agent/rules/`（Antigravity 的原生規則目錄）。
> 實測確認 Rules 面板只認 `AGENTS.md` 之後就刪掉了——留著等於同一件事有兩份說法，
> 正是本節在防的事。**不要再加回來。**

> **重要**：Claude Code **不讀 `AGENTS.md`**（官方原文：*Claude Code reads `CLAUDE.md`,
> not `AGENTS.md`*）。它是靠 `CLAUDE.md` 第一行的 `@AGENTS.md` **import 語法**才載入的。
>
> **真實事故**：`CLAUDE.md` 原本寫的是 Markdown 連結 ``[`AGENTS.md`](AGENTS.md)``，
> 看起來像指過去了，實際上完全沒生效——import 解析還會刻意跳過反引號內的內容，
> 雙重失效。這份 `AGENTS.md` 因此從未進入任何 Claude Code session 的 context。
> 不要把那一行改回連結形式。

**派工給任何 AI 時，直接說「動手前先讀 `AGENTS.md`」**——三個工具都能靠這句話找到正確入口。

---

## 7. 靜態安全網

```bash
npm run lint    # eslint（src 與 electron 兩邊）：抓「用了沒 import 的名稱」＋兩道封裝圍籬
npm run build   # rollup：抓「import 了某模組未 export 的名稱」（eslint 抓不到）
npm test        # vitest：純函式與資料完整性
grep -rn "from './app.js'" src   # 應為空——不可再引入對 app.js 的相依
```

架構規則：**沒有任何模組可以 `import … from './app.js'`。**
低階模組要觸發重繪／指令時用 `emit('事件名', …)`（`events.js`），
由 `app.js` 以 `on(...)` 訂閱。

### 兩道封裝圍籬（eslint `no-restricted-syntax`）

違反這兩條的後果都是**靜默**的，所以用 lint 擋而不是靠自律：

| 圍籬 | 內容 | 例外 |
|------|------|------|
| **選取狀態** | 不可直接寫 `State.selectedId` / `selectedIds` / `selectedClipId` / `selectedAudioClipId` / `activeTrackKind`，改用 `setSelection` / `deselect` / `pruneSelection` / `focusTrackKind` | `src/state.js` |
| **Media 內部** | 不可讀寫 `Media._*`，改用公開入口（`activeClip()` / `inGap()` / `sourceLocalTime()` / `mpvPresenting()` / `webCodecsTakeover()`…） | `src/media.js` |

> `no-restricted-syntax` 在 flat config 裡是**整組取代**而非累加。兩條圍籬因此寫在
> 同一份清單再依檔案拆 block；分開寫成兩個 block 會讓後者**無聲地**關掉前者。

---

## 8. Agent skills 設定

本 repo 已跑過 `/setup-matt-pocock-skills`。以下 skill 會讀取 `docs/agents/` 下的設定：
`/to-tickets`、`/triage`、`/to-spec`、`/wayfinder`、`/implement`、
`/improve-codebase-architecture`、`/diagnosing-bugs`、`/tdd`。

### Issue tracker

Issue 放在 **GitHub Issues**，用 `gh` CLI 操作；**外部 PR 不納入 triage**。
Issue 內容用繁體中文撰寫（與 §5 提交訊息一致）。
詳見 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。

### Triage 標籤

五個角色使用**預設名稱**（`needs-triage` / `needs-info` / `ready-for-agent` /
`ready-for-human` / `wontfix`）；`wontfix` 沿用 repo 既有標籤，未另建重複的。
詳見 [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)。

### Domain docs

**單一 context**：根目錄 `CONTEXT.md` + `docs/adr/`。兩者目前都尚未建立——
這是刻意的，由 `/domain-modeling` 在真的解決了某個詞彙或決策時順勢建立，
不要為了補齊而預先產生空殼。
詳見 [`docs/agents/domain.md`](docs/agents/domain.md)。

> **為什麼這一節在 `AGENTS.md` 而不是 `CLAUDE.md`**：skill 的預設規則是
> 「`CLAUDE.md` 存在就寫進去」，但本專案的 `CLAUDE.md` 只是 `@AGENTS.md` 的轉接層，
> Codex 與 Antigravity 都不讀它（見 §6）。這一節三個工具都需要看到。
