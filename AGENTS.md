# AGENTS.md — 給 AI 助理的專案規則

動手前讀完本檔。Antigravity IDE、Claude Code 與 OpenAI Codex 共用這份規則；`CLAUDE.md` 只負責載入，不另存規則副本。

## 0. 最高優先：不要做這四件事

### 0.1 絕對不要對版號做全域字串取代

版號只改 `package.json` 與 `package-lock.json`，統一經 §4 的 `release:prepare` 執行。文件標頭不加當前版號；套件 manifest 是唯一真相來源。

| 文件中的版號 | 處理方式 |
|---|---|
| 歷史標題、事故起始版、修復版與內文交叉引用 | 永遠保留歷史事實 |
| 當前安裝檔檔名範例 | 確有需要才更新 |

事故：`17aa365` 升版時全檔取代 changelog，95 筆歷史版號被毀，出現 121 筆同版標題與同版既造成又修復的敘述；v5.2.0 又重演，v5.2.2 才從 Git 還原。新增版本只插在導言分隔線後、現有最新版本前。

### 0.2 不要在沒讀懂上下文時貼上大段內容

編輯前讀插入點前後文，編輯後重讀完整段落。README 曾整段重複並留下未閉合 code fence；桌面安裝步驟也曾被貼進網頁版段落。檢查內容位置、重複文字與 Markdown 邊界。

### 0.3 不要用「有產出」當成「做對了」

驗證內容與語意，不能只看 exit code 或檔案存在。測試方法本身也可能出錯；實例與規則見[技術架構 §0.6](docs/技術架構說明.md#06-有產出不等於對驗證要看內容)。

### 0.4 絕對不要在專案根目錄跑 `asar extract-file`

此命令依 basename 寫入 cwd，取出封裝的 `dist/index.html` 會覆蓋根目錄 Vite 原始碼入口。若需解檔，先切到獨立暫存目錄；也可用 asar Buffer API 比較內容。

已發生兩次：v6.1.7 的 `dbc047b` 覆蓋後又刪除入口，`074572d` 還原；v6.1.9 的 `9544570` 將產物當原碼提交，v6.1.10 還原。兩次 lint／test／build 均可能全綠，因為 Vite 仍能再次 bundle 產物。

[sourceEntryHtml.test.js](tests/sourceEntryHtml.test.js) 必須確認入口保有 `<script type="module" src="/src/main.js">`、沒有建置注入的 CSP meta，且大小仍是原碼量級。測試紅時，先查是否遭產物覆蓋，不改弱測試。

## 1. 專案是什麼

Arctime 風格的多軌時間軸字幕工具。Vite、原生 ES 模組、無框架，以 `vite-plugin-singlefile` 建置單一 `dist/index.html`。同一 renderer 跑網頁與 Electron，透過 `window.subtool`／`IS_DESKTOP` 區分。

| 位置 | 邊界 |
|---|---|
| `src/` | renderer ESM、播放與 WebCodecs |
| `electron/` | 主行程、preload、ffmpeg／mpv adapters |
| `shared/` | 兩行程共用、零相依的純 CommonJS 規則 |
| `scripts/`、`tests/` | 驗收／診斷／發版工具與 Vitest |
| `docs/`、`font/` | 文件與自備字型；字型資料夾名為 UI 顯示名 |

新增、搬移或改名之前，先讀[開發文件 §6](docs/開發與驗證.md#6-目錄結構與命名)。加入 `shared/` 前，先讀 [shared/README.md](shared/README.md)：只有相同領域規則才合併；檔名淨化與路徑圍堵等分層防線不能因相似就合併。契約測試證明兩份副本一致，不代表規則正確。

## 2. 改程式碼前必讀：鐵律

修改程式前讀完[技術架構說明 §0](docs/技術架構說明.md)。下表是索引，不能代替原文與案例。

| 節 | 不變量 |
|---|---|
| §0.1 | HTML、mpv/libass、燒錄三路都只吃 `substyle.js` 的 `effStyle()` 結果 |
| §0.2 | 字級縮放基準為畫面高 ÷ PlayResY |
| §0.3 | ASS Fontname 使用字型檔內部家族名 |
| §0.4 | Windows filtergraph 路徑跳脫兩層（`C\\:/...`） |
| §0.5 | 對外時間軸時間、播放器來源時間，僅在序列層轉換 |
| §0.6 | 驗證實際內容，不能以有產出當正確 |
| §0.7 | 顯示狀態看 computed style |
| §0.8 | 音訊素材、專案 bus、交付聲道各有獨立意義 |
| §0.9 | 靜態圖片也是時間軸片段 |

修改時碼、播放點、seek、逐格、倒帶或 presenter 前，再讀 [FPS／時碼一致性](docs/FPS_時碼一致性.md)的八條不變量；相關程式可搜尋 `FPS-SYNC`。

## 3. 文件職責（不要把內容寫到錯的檔案）

一件事只在唯一位置寫完整，其他文件放連結。新增文件類別必須更新本表及 README 入口。

| 文件 | 唯一職責 | 讀者 |
|---|---|---|
| `README.md` | 專案入口、快速開始、文件導覽 | 所有人 |
| `docs/使用說明.md` | 操作、快捷鍵、字幕格式 | 使用者 |
| `docs/開發與驗證.md` | 環境、指令、發版、CDP、大檔驗收、目錄命名 | 開發者 |
| `docs/技術架構說明.md` | 鐵律、模組、資料流、樣式、WebCodecs、demux | 維護者 |
| `docs/Electron_維護手冊.md` | IPC、ffmpeg／mpv、封裝與排查 | 維護者 |
| `docs/FPS_時碼一致性.md` | 八條時間不變量與踩雷案例 | 維護者 |
| `docs/版本變更紀錄.md` | 版本歷史與驗證證據 | 所有人 |
| [docs/research/](docs/research/) | 標註日期並引用主要來源的時效性研究 | 維護者 |
| [CONTEXT.md](CONTEXT.md) | 領域定義，不放實作教學 | 所有人 |
| [docs/adr/](docs/adr/) | 決策理由、代價與推翻條件 | 維護者 |
| [shared/README.md](shared/README.md) | 共用純規則的加入與分層條件 | 維護者 |
| `AGENTS.md`、`CLAUDE.md` | 共用維護規則與 Claude 載入轉接 | AI 維護工具 |
| [docs/agents/](docs/agents/) | Issue tracker、triage 角色與領域文件設定 | 工程 skills |

CONTEXT 與 ADR 曾因沒有文件入口而只有搜尋找得到；兩者建立後，舊規則還聲稱「尚未建立」。新增文件時同步修正索引與 §8，避免開場 context 主動誤導下一位維護者。

## 4. 發版流程

Windows 正式發版依序完成：

1. `npm run lint`、`npm test`、`npm run build` 全綠。
2. 桌面真機驗證，檢查實際畫面、音訊與交付內容。
3. 把「為什麼改／怎麼驗」寫入 UTF-8 暫存 notes，執行 `npm run release:prepare -- --version X.Y.Z --date YYYY-MM-DD --notes <notes檔路徑>`。
4. `npm run dist` 產生 `release/SUB Tool Setup X.Y.Z.exe`。
5. 實際安裝同一份 exe，確認 app 顯示版號、封裝來源與原生能力。
6. 明確 stage 本版檔案，以繁體中文 commit，push `origin main`。
7. 建立 GitHub Release，附上同一支已驗證 exe。

`release:prepare` 是版號與 changelog 的唯一 mutation 入口。它從 Git 建立 production source evidence，拒絕重複版號或缺少驗證段落，寫入任一檔失敗會回復 transaction。參數與詳細驗收以[開發文件 §2](docs/開發與驗證.md#2-建置與發版流程)為準。

本專案直接由 main 發佈。工作樹混有別的工具或使用者修改時，不可 `git add -A`；先確認本版範圍。變更紀錄保留原因、內容驗證與限制，不能只列「修了 X」。

Apple Silicon 的 `npm run dist:mac:test` 只供本機 unsigned 驗證，不能直接上傳 Release。正式 Mac 發佈仍需 Developer ID、hardened runtime、Apple notarization 與實體 Mac 驗收，見[平台分流](docs/開發與驗證.md#apple-silicon-本機測試版)。

## 5. 提交訊息

一律用繁體中文，說明改了什麼與原因。不得只寫「修正 bug」。

## 6. 多工具協作注意事項

- 工作樹不一定乾淨，未提交內容不一定屬於你。大範圍修改前先 `git status`；讀取後隔一段時間才編輯，先重讀。
- 不另建 `.cursorrules`、`GEMINI.md` 或 `.agent/rules/` 等重複規則。共用規則只在本檔，其他工具用入口轉接。
- 派工時明確說「動手前先讀 `AGENTS.md`」。README 是人類入口，不能假設工具自動載入。

| 工具 | 本專案入口 | 全域規則 |
|---|---|---|
| Claude Code | `CLAUDE.md` 第一行 `@AGENTS.md` import | `~/.claude/CLAUDE.md` |
| OpenAI Codex | 原生讀取 `AGENTS.md` | `~/.codex/AGENTS.md` |
| Antigravity | 啟用 `chat.useAgentsMdFile: true` | `~/.gemini/GEMINI.md` |

Claude Code 不自動讀 AGENTS，曾因入口只是 Markdown 連結而整份規則未載入；不可把 import 改回連結或反引號。Antigravity 已實測在 Customizations → Rules 顯示 `Project · AGENTS.md`；曾建的 `.agent/rules/` 已刪除，不加回。

## 7. 靜態安全網

```bash
npm run lint
npm test
npm run build
rg "from './app.js'" src
```

最後一項應無結果。任何模組都不能 import `app.js`；低階模組用 `events.js` 的 `emit`，由 app 或專責上層 bridge／view 訂閱 `on`。lint 抓未定義名稱與封裝邊界；build 抓缺少 export 的 import；測試驗證行為與資料完整性。

新增頂層程式資料夾時，同步加進 lint 指令及 ESLint 範圍。只有 config block、沒有 CLI 參數也不會檢查；electron 曾有 2,268 行因此漏檢，shared 建立時也差點重演。

### 兩道封裝圍籬（eslint `no-restricted-syntax`）

| 圍籬 | 必須使用的公開入口 | 唯一例外來源 |
|---|---|---|
| 禁止直接寫 `State.selectedId`／`selectedIds`／`selectedClipId`／`selectedAudioClipId`／`activeTrackKind` | `setSelection`、`deselect`、`pruneSelection`、`focusTrackKind` | `src/state.js` |
| 禁止外部讀寫 `Media._*` | `activeClip()`、`inGap()`、`sourceLocalTime()`、`mpvPresenting()`、`webCodecsTakeover()` 等公開 API | [eslint.config.mjs](eslint.config.mjs) 的 `MEDIA_INTERNAL_FILES` |

Flat config 的 `no-restricted-syntax` 會整組取代，兩條圍籬要維持同一清單、再依檔案分 block；不可拆成互相覆蓋的兩組規則。

## 8. Agent skills 設定

已套用 `/setup-matt-pocock-skills`。`/to-tickets`、`/triage`、`/to-spec`、`/wayfinder`、`/implement`、`/improve-codebase-architecture`、`/diagnosing-bugs`、`/tdd` 使用下列設定：

| 設定 | 文件 |
|---|---|
| GitHub Issues、`gh`、繁體中文、外部 PR 不納入 triage | [issue-tracker.md](docs/agents/issue-tracker.md) |
| 五個預設角色：needs-triage、needs-info、ready-for-agent、ready-for-human、wontfix；不新增重複標籤 | [triage-labels.md](docs/agents/triage-labels.md) |
| 單一 CONTEXT 與根層 ADR，實際解決詞彙／決策時才用 domain-modeling 補充 | [domain.md](docs/agents/domain.md) |

這些設定放在共用 AGENTS，不能移去只有 Claude 會載入的轉接檔。CONTEXT 與 ADR 已存在，不預建空殼；新增類別時回頭更新 §3 與本節。
