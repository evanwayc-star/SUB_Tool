# SUB Tool 維護規則

動手前讀完本檔，派工時明示「動手前先讀 `AGENTS.md`」。先跑 `git status --short --branch`，保留他人的修改。

改程式讀 §2，其他任務從 §3 選文件。長手冊先列標題行號，如 `git grep -n -E "^#{2,3} " -- docs/使用說明.md`；歷史用[單版查詢](docs/版本變更紀錄.md#只讀指定版本)。

## 0. 避免資料損失

- **版號**只由 `release:prepare` 更新 `package.json`、`package-lock.json`，並在導言分隔線後插入新版本。禁止全域取代；歷史標題、事故版、修復版與引用原樣保留。現行版號查 manifest，文件標頭免列。
- **ASAR** 只在獨立暫存目錄執行 `asar extract-file`，或用 Buffer API。根目錄執行會覆蓋 Vite 入口。測試失敗先查 `index.html` 是否仍為原碼大小、有 `<script type="module" src="/src/main.js">` 且無建置 CSP。[入口測試](tests/sourceEntryHtml.test.js)
- **文件**先讀插入點前後文，隔久重讀；改後核對完整段落、平台、重複文字、連結與 code fence。
- **驗證**要讀回畫格、字幕、音訊或成品對照預期，連測試方法本身也要核對。[架構 §0.6](docs/技術架構說明.md#06-有產出不等於正確)

## 1. 專案邊界

Vite 將原生 ES 模組建成單一 `dist/index.html`。網頁與 Electron 共用 `src/` renderer，由 `window.subtool`／`IS_DESKTOP` 分流。`electron/` 放 main、preload 與原生工具，`shared/` 放純 CommonJS 規則。

## 2. 改程式前必讀

1. 改任何程式碼，讀完[架構 §0 的九條鐵律](docs/技術架構說明.md#0-鐵律invariants)。
2. 改 FPS、時碼、播放點、seek、逐格、倒帶或 presenter，另讀 [FPS 八條不變量](docs/FPS_時碼一致性.md#2-八條不變量)。程式搜尋 `FPS-SYNC`。
3. 新增、搬移或改名先查[目錄與命名](docs/開發與驗證.md#6-目錄結構與命名)。加入 `shared/` 先查[共用條件](shared/README.md)，保留檔名淨化與路徑圍堵的獨立防線。

<a id="3-文件職責不要把內容寫到錯的檔案"></a>

## 3. 文件職責

一個主題寫在一處，其餘連回該節。新增類別同步更新本節、[README 導覽](README.md#文件導覽)及相關 §8 設定。

| 要查的事 | 入口 |
|---|---|
| 安裝、打點、快捷鍵、字幕格式 | [README](README.md) 快速開始 → [使用說明](docs/使用說明.md) |
| 指令、驗收、發版、目錄命名 | [開發與驗證](docs/開發與驗證.md) |
| 模組、資料流、播放與原生整合 | [技術架構](docs/技術架構說明.md) · [Electron 維護](docs/Electron_維護手冊.md) · [FPS／時碼](docs/FPS_時碼一致性.md) |
| 領域詞義、設計決策、兩端共用條件 | [CONTEXT](CONTEXT.md) · [ADR](docs/adr/) · [shared](shared/README.md) |
| 某版的修改與驗證、技術評估及來源 | [版本紀錄](docs/版本變更紀錄.md)（按版查） · [研究](docs/research/)（按日期查） |
| 工具規則與工程任務 | 本檔與 §6 的載入方式 · [工程設定](docs/agents/) |

## 4. 發版流程

Windows 正式版依序完成，命令與驗收標準見[開發 §2](docs/開發與驗證.md#2-建置與發版流程)。

1. 跑 §7 的 lint、test、build，再於桌面真機核對畫面、音訊與交付。
2. 將原因、驗證與限制寫成 UTF-8 notes。執行 `npm run release:prepare -- --version X.Y.Z --date YYYY-MM-DD --notes <路徑>`。
3. 執行 `npm run dist`，安裝產出的 `release/SUB Tool Setup X.Y.Z.exe`，核對顯示版號、封裝來源與原生能力。
4. 逐檔 stage 本版範圍、提交、推送 `origin main`。建立 GitHub Release，附上同一支驗過的 exe。

Apple Silicon 的 `dist:mac:test` 是本機 unsigned 測試包。正式 Mac 發佈需 Developer ID、hardened runtime、公證與實體 Mac 驗收。[Mac 測試流程](docs/開發與驗證.md#apple-silicon-本機測試版)

## 5. 提交訊息

用繁體中文說明修改內容與原因。工作樹混有其他修改時禁止 `git add -A`。

## 6. 多工具協作

Codex 原生載入本檔。Claude Code 由 `CLAUDE.md` 第一行的 `@AGENTS.md` 載入。Antigravity 啟用 `chat.useAgentsMdFile: true`。共用規則只維護一份，其他工具使用載入入口。

## 7. 靜態安全網

程式改動依序跑 `npm run lint`、`npm test`、`npm run build`。以 `git grep -n -F "from './app.js'" -- src` 核對無結果。低階模組經 `events.js` 發出事件，由上層訂閱，避免回頭 import `app.js`。

| 邊界 | 公開入口與例外 |
|---|---|
| 選取狀態 | 只有 `src/state.js` 可直接寫 `selectedId`、`selectedIds`、`selectedClipId`、`selectedAudioClipId`、`activeTrackKind`。其他模組用 `setSelection`、`deselect`、`pruneSelection`、`focusTrackKind`。 |
| `Media._*` | 除 [`MEDIA_INTERNAL_FILES`](eslint.config.mjs) 清單外，走 `activeClip()`、`inGap()`、`sourceLocalTime()`、`mpvPresenting()`、`webCodecsTakeover()` 等公開 API。 |

ESLint flat config 會整組取代 `no-restricted-syntax`。兩道規則共用清單，再依檔案分 block。新增頂層程式目錄時，同步更新 lint CLI 參數與 ESLint 範圍。

## 8. Agent skills 設定

工程 skills 共用[領域文件設定](docs/agents/domain.md)。處理 Issue／Wayfinder 時讀 [Issue tracker](docs/agents/issue-tracker.md)，分流時查 [triage 標籤](docs/agents/triage-labels.md)。適用於 `/to-tickets`、`/triage`、`/to-spec`、`/wayfinder`、`/implement`、`/improve-codebase-architecture`、`/diagnosing-bugs`、`/tdd`。
