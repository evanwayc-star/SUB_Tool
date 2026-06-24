# SUB Tool — 架構與程式碼說明文件

> 版本：v2.8.0｜最後更新：2026-06-24

---

## 目錄

1. [專案概述](#1-專案概述)
2. [整體架構](#2-整體架構)
3. [模組職責](#3-模組職責)
4. [模組相依關係](#4-模組相依關係)
5. [資料流](#5-資料流)
6. [Electron 與瀏覽器雙模式差異](#6-electron-與瀏覽器雙模式差異)
7. [關鍵流程說明](#7-關鍵流程說明)
   - [字幕渲染流程](#71-字幕渲染流程)
   - [時間軸互動流程](#72-時間軸互動流程)
   - [音訊混音流程](#73-音訊混音流程)
   - [匯入匯出流程](#74-匯入匯出流程)
   - [I/O 上字幕流程](#75-io-上字幕流程)
   - [Undo/Redo 流程](#76-undoredo-流程)

---

## 1. 專案概述

SUB Tool 是一款 **Arctime 風格的多軌字幕編輯工具**，以 Vite + ES Modules 架構開發，支援兩種執行模式：

| 模式 | 執行方式 | 限制 |
|------|---------|------|
| **瀏覽器版** | 雙擊 `dist/index.html` 或 `npm run dev` | MXF 受 1.6 GB 記憶體限制；多軌需 ffmpeg.wasm（需網路） |
| **Electron 桌面版** | `啟動桌面版.bat` / `npm run electron:dev` | 呼叫系統 ffmpeg，可直讀 MXF、多軌、超大檔 |

建置輸出：`npm run build` → `dist/index.html`（vite-plugin-singlefile，單一可雙擊執行的 HTML）。

---

## 2. 整體架構

```
src/
 ├── main.js          ← Vite 進入點（引入 styles.css + app.js）
 ├── app.js           ← 協調層（非 hub：訂閱事件、接線 UI、init）
 │
 ├── ── 葉模組（零或僅向下相依）──
 ├── dom.js           ← DOM 元素參照
 ├── util.js          ← 純工具函式（數值/編碼/檔案）
 ├── time.js          ← 時碼換算（秒 ↔ SRT/ASS/Encore/DF）
 ├── tcparse.js       ← 時碼輸入解析（字串 → 秒）
 ├── events.js        ← 同步事件匯流排（on/emit）
 │
 ├── ── 領域模組 ──
 ├── state.js         ← 全域可變狀態（cues/tracks/FPS/選取…）
 ├── formats.js       ← SRT/ASS/Encore/TXT 解析與序列化
 ├── media.js         ← 媒體引擎（影片 + Web Audio + ffmpeg）＋ Wave
 ├── timeline.js      ← Canvas 時間軸渲染與拖曳互動
 ├── subtitles.js     ← 字幕列表 CRUD / 選取 / 搜尋取代
 ├── keyboard.js      ← 鍵盤快捷鍵 + I/O 上字幕 + JKL 穿梭
 ├── subio.js         ← 匯入/匯出/拖放/FPS 轉換/時間碼位移
 ├── project.js       ← .subtool 專案存讀 + 自動備份
 ├── history.js       ← Undo/Redo（structuredClone 快照）
 ├── notes.js         ← 備忘錄面板（時間點標記）
 ├── mixer.js         ← 音軌列表 + 混音器 + 電平表 UI
 ├── menus.js         ← 右鍵選單（播放窗 / 字幕 / 時間軸）
 ├── ui.js            ← UI 基本元件（狀態列/Toast/OSD/對話框）
 └── help.js          ← 說明對話框

electron/
 ├── main.js          ← Electron 主程序（IPC：ffmpeg/mpv/檔案對話框）
 └── preload.js       ← contextBridge → window.subtool（安全橋接）
```

### 架構核心原則

- **`app.js` 不再是 hub**：其他模組不 `import app.js`，而是呼叫 `emit(event)` → `app.js` 以 `on(event, handler)` 訂閱後執行對應函式。這斷開了雙向循環相依。
- **`events.js` 為同步匯流排**：`emit` 同步執行所有 handler，語意等同直接呼叫（無非同步延遲）。
- **`State` 為唯一可變狀態來源**：各模組直接讀寫 `State`，變動後透過 `emit('render:all')` 等事件觸發重繪，不使用框架的響應式系統。

---

## 3. 模組職責

### `main.js`（進入點）
Vite 的模組根目錄進入點，僅兩行：引入 CSS 與 `app.js`。

---

### `app.js`（協調層，~812 行）
**職責**：組裝所有模組、訂閱事件、影片事件處理、`doAction` 指令分派、面板/選單接線、`init` / `initDesktop`。

**不**負責任何渲染邏輯——只負責「知道哪個事件要呼叫哪個函式」。

**關鍵函式**：

| 函式 | 說明 |
|------|------|
| `renderAll()` | 呼叫 `renderSubList` + `renderCueBlocks` + `renderVideoSub` + `updateTlSel` |
| `renderVideoSub()` | 更新 `#videoSub` 疊層，顯示播放點當下的字幕文字 |
| `onDurationKnown()` | 影片/音訊片長確認後，更新 seekBar、時碼顯示、時間軸 |
| `doAction(name)` | 集中指令分派（open-media, add-track, mixer, export 等） |
| `ensurePlayheadVisible()` | 播放點超出視窗時自動捲動 |
| `refreshMpvSubs()` | mpv 模式下，字幕變動時重建 .ass 餵給 mpv（防抖 100ms） |
| `rafLoop()` | requestAnimationFrame 主迴圈：播放中更新時碼/seekBar/波形即時擷取/電平表 |
| `init()` | 瀏覽器模式初始化（載入拖放、FPS 選單、面板接線…） |
| `initDesktop()` | Electron 模式初始化（呼叫 `DESK` IPC：ffmpeg 路徑、開啟對話框） |

---

### `dom.js`（DOM 元素參照）
```js
const $ = id => document.getElementById(id);
const video    // <video id="video">
const tlScroll // 時間軸滾動容器
const tlLayer  // 時間軸絕對定位層
const tlTracks // 軌道列容器
const rulerCv  // 尺 Canvas
const waveCv   // 波形 Canvas
const sublist  // 字幕列表 <div>
```

---

### `util.js`（純工具）
| 函式 | 說明 |
|------|------|
| `clamp(v,a,b)` | 數值夾緊 |
| `pad(n,w)` | 補零格式化 |
| `decodeText(buf)` | ArrayBuffer → 字串，自動偵測 UTF-8/UTF-16 LE/BE + BOM |
| `encodeUTF16LE(str)` | 字串 → UTF-16 LE（含 BOM）Uint8Array |
| `downloadBytes(bytes,name)` | 觸發瀏覽器下載（含 iOS DataURL 路徑） |
| `readFile(file)` | File → ArrayBuffer（Promise） |
| `escapeHTML(s)` | HTML 跳脫 |

---

### `time.js`（時碼換算）
| 函式 | 說明 |
|------|------|
| `fmtClock(s)` | 秒 → `00:00:00.000`（UI 顯示） |
| `secToSRT(s)` | 秒 → SRT 時碼（`,` 分隔毫秒） |
| `secToASS(s)` | 秒 → ASS 時碼（`.` 分隔百分秒） |
| `secToEncore(s,fps,df)` | 秒 → Encore 時碼（H:M:S:F），支援 SMPTE 29.97 Drop-frame |
| `encoreToSec(t,fps,df)` | Encore 時碼 → 秒（Drop-frame 反運算） |
| `snapTimeToFrame(t,fps,df)` | 秒數對齊最近影格邊界 |

---

### `tcparse.js`（時碼輸入解析）
`parseTimecodeInput(str) → 秒`

支援格式：
- 完整時碼：`01:23:45:12`、`01:23:45;12`（DF）
- 緊湊數字：`12345` → 由右至左解析為 格/秒/分/時
- 相對偏移：`+100` / `-100`（由 `subtitles.js` 處理正負號前置）

---

### `events.js`（同步事件匯流排）
```js
on(evt, fn)    // 訂閱
emit(evt, ...args) // 同步觸發所有 handler
```

**事件清單**：

| 事件 | 觸發時機 | Handler（app.js 訂閱） |
|------|---------|----------------------|
| `render:all` | 字幕/軌道任何變動 | `renderAll()` |
| `render:videoSub` | 播放點移動、字幕文字變動 | `renderVideoSub()` |
| `render:listTrackSel` | 軌道新增/刪除/改名 | `renderListTrackSel()` |
| `render:trackStyle` | 軌道樣式變更 | `renderTrackStyle()` |
| `playhead:ensure` | seek 後 | `ensurePlayheadVisible()` |
| `duration:known` | 媒體片長確定 | `onDurationKnown()` |
| `mpv:refreshSubs` | mpv 模式字幕變動 | `refreshMpvSubs()` |
| `panel:toggle` | 面板開關 | `togglePanel()` |
| `note:openInPanel` | 時間尺雙擊備忘 | `openNoteInPanel()` |
| `cue:openEdit` | 雙擊時間軸字幕區塊 | `openCueEditModal()` |
| `action` | 通用指令分派 | `doAction()` |

---

### `state.js`（全域狀態）

`State` 物件包含所有可變資料：

```js
State = {
  cues: [],          // [{id, start, end, text, track, timed}]
  tracks: [],        // [{name, visible, fontScale, posPct, align, locked, color}]
  notes: [],         // [{id, time, text, done}]
  fps: 24,           // 目前影格率
  dropFrame: false,  // 是否 Drop-frame（29.97 DF）
  duration: 0,       // 片長（秒）
  selectedId: null,  // 主選取字幕 id
  selectedIds: [],   // 多選集合
  activeEdge: 'start',// 上下鍵步進中停在 start 或 end
  pxPerSec: 80,      // 時間軸縮放（每秒像素數）
  viewStart: 0,      // 時間軸左緣對應秒數
  inPoint: null,     // I 按下但尚未 O 的暫存起點
  subMode: false,    // 上字幕模式（O 後自動跳下一句）
  ...
}
```

**工具函式**：
- `newTrack(name)` — 建立軌道物件
- `setFps(v)` — 設定影格率（同步更新 UI 下拉選單與時碼顯示）
- `snapFps(v)` — 將任意 fps 值對齊到允許集合（23.976/24/25/29.97/30）
- `DESK` — Electron `window.subtool` 橋接物件（`null` 表示瀏覽器模式）
- `IS_DESKTOP` — 布林，是否為 Electron 模式

---

### `formats.js`（字幕格式解析/序列化）

`SubFormats` 物件包含四種格式的解析器與序列化器：

| 格式 | 解析 | 序列化 |
|------|------|--------|
| SRT | `parseSRT(text)` | `toSRT(cues)` |
| ASS | `parseASS(text)` | `toASS(cues, fps, tracks, ...)` |
| Adobe Encore | `parseEncore(text, fps, df)` | `toEncore(cues, fps, df)` |
| 純文字 | `parseTXT(text)` | `toTXT(cues)` |

**ASS 輸出細節**：
- 每個字幕軌道對應一個 `Style: Track{N}` 樣式
- 字型大小以影像寬度的 2.5% 為基準，再乘以該軌道的 `fontScale`
- 垂直位置（`MarginV`）以 `posPct`（距底部百分比）換算為像素

---

### `media.js`（媒體引擎，~1091 行）

#### Media 物件
管理影片播放、Web Audio 多軌混音、ffmpeg 整合。

**音軌種類**（`track.kind`）：

| kind | 說明 |
|------|------|
| `native` | 原生影片立體聲 L/R（`_connectStereo()` 分頻） |
| `element` | `<audio>` 元素（外部音檔或抽取聲道） |
| `buffer` | AudioBuffer（ffmpeg.wasm 解碼後存入記憶體） |
| `nativeTrack` | 瀏覽器原生多音軌（少數瀏覽器支援） |

**播放狀態機**：
```
[無媒體] ─── loadVideoFile/loadDesktopMedia ──→ [有媒體]
                                                  ↕ play/pause
                                               [播放中]
```

**虛擬播放模式**（`video.src` 為空時）：
- 以 `performance.now()` 計時模擬播放位置
- `_vTime` + `_vStart` 維護當前時間

**seek 精準對齊**：每次 `seek(t)` 都呼叫 `snapTimeToFrame(t, fps, df)` 確保落在整格。

#### Wave 物件
波形峰值資料管理。

| 方法 | 說明 |
|------|------|
| `compute(ab, chIdx)` | 從 AudioBuffer 計算 min/max 峰值桶（100 桶/秒） |
| `computeFromWav(buf)` | 直接從 WAV ArrayBuffer 解析（不需 decodeAudioData，供 Electron 快取讀取） |
| `initLive()` | 長片模式：初始化空白峰值陣列，播放時由 `captureLive()` 逐桶填入 |
| `captureLive()` | 由 `rafLoop` 呼叫，從 AnalyserNode 擷取即時波形 |
| `registerSources(wavePath, channels)` | 記錄多音源（主混音 + 各聲道），驅動波形來源選擇器 |
| `selectSource(idx)` | 切換顯示哪個聲道的波形（延遲解碼） |

---

### `timeline.js`（時間軸，~637 行）

#### 座標系統
```
Y軸：
  0               RULER_H(24px)    → 尺（Canvas）
  RULER_H         +waveH(64px)     → 波形（Canvas）
  RULER_H+waveH   以下             → 軌道列（DOM div，可垂直捲動）

X軸：
  timeToX(t) = (t - State.viewStart) * State.pxPerSec
  xToTime(x) = State.viewStart + x / State.pxPerSec
```

#### 主要渲染函式

| 函式 | 說明 |
|------|------|
| `drawTimeline()` | 全量重繪（layout + ruler + wave + track rows + playhead） |
| `drawRuler()` | Canvas 繪製時間尺刻度與備忘三角標記 |
| `drawWave()` | Canvas 繪製波形（逐像素查峰值桶，跨桶取極值） |
| `renderTrackRows()` | DOM 重建軌道列、gutter（名稱/眼睛/鎖定/拖曳把手） |
| `renderCueBlocks()` | DOM 重建字幕區塊（含磁吸/重疊偵測） |
| `updatePlayhead()` | 僅移動播放頭位置（非全量重繪） |

#### 拖曳互動
`mousedown` → 判斷目標（字幕區塊邊緣/中心、時間尺、空白軌道）→ 設定 `drag` 狀態：
- `move`：群組移動（多選），磁吸播放點 + 其他字幕邊界，防同軌重疊
- `l`/`r`：縮放左/右邊界，同樣磁吸
- `scrub`：拖曳時間尺移動播放頭
- `rubber`：框選（矩形範圍選取）

拖曳期間優化：只更新 `.cue-block` 的 `style.left/width`，不全量重繪。`mouseup` 才呼叫 `renderAll`。

---

### `subtitles.js`（字幕列表，~645 行）

#### 字幕資料結構
```js
{
  id: 'c1',          // 唯一 id（newId() 遞增）
  start: 10.5,       // 起點秒數
  end: 13.2,         // 終點秒數
  text: '你好世界',  // 字幕文字（換行用 \n）
  track: 0,          // 軌道索引（0-based）
  timed: true        // false = 未定時（Encore 的 --:--:--:--）
}
```

#### 主要函式

| 函式 | 說明 |
|------|------|
| `renderSubList()` | 全量重建字幕列表 DOM，包含重疊偵測、搜尋高亮、字數超限標記 |
| `renderSubRow(id)` | 單條更新（拖曳時用，避免全量重建） |
| `selectCue(id, opts)` | 選取邏輯（單選/加選/範圍選，自動切換列表軌道） |
| `addCue(start,end,text,track)` | 新增字幕，自動排序 |
| `deleteSelected()` | 刪除選取（刪後自動選相鄰條目） |
| `splitCueAtCursor(c, txtEl)` | Ctrl+Enter 在游標處拆分字幕（插入 U+0001 標記字元取得游標位置） |
| `searchUpdate()` | 搜尋（支援 `||` OR 多條件），高亮並選取第一個結果 |
| `copyCues()` / `pasteCues()` | 複製貼上（貼上時以播放點為基準位移時碼） |

#### 字幕列表事件代理
`sublist` 以事件代理（Event Delegation）處理：
- `click` → 時碼欄位內嵌編輯（`openInlineTimeEdit`）
- `mousedown` → 選取邏輯（含 Ctrl/Shift 多選）
- `dblclick` → 開啟 `contenteditable` 文字編輯
- `contextmenu` → 字幕右鍵選單
- `input` / `focusout` → 即時同步 `c.text`、觸發重繪

---

### `keyboard.js`（鍵盤 + I/O + JKL，~429 行）

#### JKL 穿梭輪
```
J 鍵：-1 → -5（每按一次 -0.5）— 負速度以 setInterval 逐格倒退
K 鍵：暫停（_jklSpeed = 0）
L 鍵：+1 → +5（每按一次 +0.5）— 正速度以 Media.setRate 加速
空白鍵：切換播放/暫停（重置 JKL 到 ×1）
```

#### 主要快捷鍵

| 鍵 | 功能 |
|----|------|
| `I` | 設定選取字幕起點（無選取則新建） |
| `O` / `C` | 設定選取字幕終點（上字幕模式下自動跳下一句） |
| `←/→` | 逐格跳（1格）；+Shift = 1秒；+Ctrl+Shift = 5秒 |
| `↑/↓` | 跳到相鄰字幕起點；+Ctrl = 步進邊界（start→end→next） |
| `Ctrl+↑/↓` | `stepBoundary`：在起/訖邊界間逐步移動（含「預覽」機制，同向再按一次才切換選取） |
| `Shift+↑/↓` | 跳到影片開頭/結尾 |
| `Ctrl+Shift+↑/↓` | 跳到同軌第一/最後字幕（`jumpToFirstLastCue`） |
| `P` | 多選位移：將選取字幕整體移到播放點 |
| `Delete` | 刪除選取 |
| `Ctrl+Z/Shift+Ctrl+Z` | Undo/Redo |
| `Ctrl+A` | 全選當前軌道 |
| `]` | 縮放至字幕範圍（`zoomFit`） |
| `\` | 縮放至全片長（`zoomFitVideo`） |
| `-/+` | 縮放時間軸（×0.77 / ×1.3） |

---

### `subio.js`（匯入/匯出，~331 行）

**格式自動辨識** (`detectSubFormat`)：依副檔名優先，次以文字特徵（`[Script Info]` → ASS；`\d+ --> \d+` → SRT；時碼模式 → Encore；其餘 → TXT）。

**匯入流程**：
1. 取得文字（Web: `FileReader`；Desktop: IPC）
2. 若尚未載入影片，彈窗詢問 FPS
3. 解析字幕（含換行符號 `\\`/`//` → `\n` 轉換）
4. 彈窗選擇目標軌道（可新增軌道或附加到現有軌道）
5. `snapTimeToFrame` 對齊影格後寫入 `State.cues`

**匯出流程**：
1. 彈窗選擇格式與軌道（多軌時每軌各一個檔案）
2. 序列化 → `encodeUTF16LE` → 下載（Web）或 IPC 寫檔（Desktop）

---

### `project.js`（專案存讀）

`.subtool` 格式為 **UTF-16 LE + BOM** 的 JSON，結構：
```json
{
  "app": "SUB Tool",
  "version": 2,
  "media": { "name": "film.mp4", "path": "C:\\...", "size": 4000000000 },
  "fps": 24,
  "dropFrame": false,
  "tracks": [...],
  "notes": [...],
  "cues": [{ "start": 10.5, "end": 13.2, "text": "...", "track": 1, "timed": true }]
}
```
注意：`cues.track` 在 v2 格式中為 **1-based**（載入時 -1 轉為 0-based）。

**自動備份**：第一次編輯前顯示「請先儲存」提示（`ensureProjectSaved`），儲存後每 3 分鐘自動備份到 `.subtool_AutoSave/` 子目錄。

---

### `history.js`（Undo/Redo）

```js
History = {
  stack: [],  // [{label, snap}]，最多 120 步
  hi: -1,     // 目前所在位置
  snap()      // structuredClone(State.cues + tracks + notes + fps)
  record(label)  // 比對前後狀態，相同則不記錄
  restore(i)     // 還原到第 i 步
  undo() / redo()
}
```

`recordHistory(label)` 為對外包裝函式，由各模組（timeline/subtitles/keyboard 等）在每次狀態變更後呼叫。

---

### `notes.js`（備忘錄）

每條備忘 = `{id, time, text, done}`，儲存於 `State.notes`，隨 `.subtool` 專案存檔。

- **時間尺橘色三角**：`drawRuler()` 渲染，雙擊觸發 `emit('note:openInPanel')`
- `updateNoteActive(t)`：播放中高亮最接近播放點（±0.5格）的備忘
- **匯出 CSV**：同時產生一般格式與 EDIUS Marker list 格式（皆為 UTF-8 BOM）

---

### `mixer.js`（混音器 UI）

- `renderAudioTracks()`：渲染側欄音軌列表（靜音/獨奏/音量推桿）
- `renderMixer()`：渲染浮動混音器面板（逐聲道電平表 + 推桿）
- `updateMeters()`：由 `rafLoop` 呼叫，從各音軌的 AnalyserNode 讀取瞬時電平，平滑衰減（×0.82/幀）並更新 CSS height

---

### `menus.js`（右鍵選單）

- `showCtx(x, y, items)`：通用右鍵選單渲染（自動防止超出視窗邊界）
- `showPlayerMenu(x, y)`：播放窗右鍵（音源切換 + 播放速度）
- `showCueMenu(x, y)`：字幕右鍵（移軌/複製貼上/對調/選取以上下/刪除）

---

### `ui.js`（UI 基本元件）

| 函式 | 說明 |
|------|------|
| `setStatus(msg, kind)` | 更新狀態列文字與指示點顏色（ok/busy/空） |
| `showToast(msg)` | 顯示底部 Toast（3.5 秒後消失） |
| `showOsd(text)` | 顯示 JKL 速度 OSD（1 秒後消失） |
| `openModal(title, html, buttons)` | 通用對話框 |
| `closeModal()` | 關閉對話框（mpv 模式下同步顯示/隱藏 mpv 視窗） |

---

### `help.js`（說明對話框）
`showHelp()` — 以 `openModal` 渲染鍵盤快捷鍵說明表格。

---

## 4. 模組相依關係

```
                       events.js ←──────────────────────────────┐
                          ↓ on/emit                              │
              ┌───────── app.js ──────────────────────────┐     │
              │   (協調層，訂閱所有事件)                   │     │
              │                                           │     │
    dom.js  util.js  time.js  tcparse.js                 │     │
      ↑        ↑        ↑         ↑                      │     │
      └────────┴────────┴─────────┘                      │     │
              state.js ─────────────────────────────────────────┘
              ↑    ↑    ↑    ↑    ↑    ↑    ↑    ↑    ↑
          formats  ui  media timeline subtitles keyboard subio
                         ↑       ↑        ↑       ↑      ↑
                       mixer   menus   project history  notes
```

**規則**：低階模組（葉節點）只能 `emit` 事件，不能 `import` `app.js`。循環相依透過事件匯流排解決。

---

## 5. 資料流

### 使用者操作 → 狀態更新 → 重繪

```
使用者操作（鍵盤/滑鼠）
    ↓
領域模組處理（keyboard/subtitles/timeline）
    ↓
修改 State（State.cues / State.tracks / ...）
    ↓
emit('render:all') / emit('render:videoSub') / ...
    ↓
app.js handler 呼叫對應渲染函式
    ↓
DOM/Canvas 更新
```

### 媒體載入資料流

```
使用者拖入影片
    ↓
Media.loadVideoFile(file)     [Web]
Media.loadDesktopMedia(path)  [Electron]
    ↓
探測格式（canPlayNatively / ffprobe）
    ↓
A. 原生可播放 → video.src = objectURL → 偵測 FPS（requestVideoFrameCallback）
B. 非原生 → ffmpeg.wasm 轉檔（Web）/ DESK.streamIngest（Electron mpv 秒開）
    ↓
Web Audio 接管音訊（_connectStereo 分頻 L/R）
    ↓
抽取多音軌（背景）
    ↓
產生波形（Wave.compute 或 Wave.initLive）
    ↓
emit('duration:known') → app.js → onDurationKnown → 更新 UI
```

---

## 6. Electron 與瀏覽器雙模式差異

### 偵測方式
```js
// state.js
const DESK = window.subtool?.isDesktop ? window.subtool : null;
const IS_DESKTOP = !!DESK;
```

### 核心差異

| 功能 | 瀏覽器版 | Electron 桌面版 |
|------|---------|----------------|
| **開啟影片** | `<input type=file>` / 拖放 → `URL.createObjectURL` | `DESK.openMedia()` → 系統對話框 → 直接路徑 |
| **MXF / 大檔支援** | ❌ ffmpeg.wasm 限 1.6 GB | ✅ 系統 ffmpeg，無大小限制 |
| **多音軌** | ffmpeg.wasm 逐一抽取（阻塞） | DESK.ingest() 單次多輸出，並行抽取 |
| **mpv 秒開** | ❌ 不支援 | ✅ 偵測到 mpv.exe 時，非原生格式幾秒內即播放 |
| **波形** | 整檔 decodeAudioData（<500MB）或播放時即時擷取 | 系統 ffmpeg 抽出 8kHz mono WAV 後解析 |
| **匯入字幕** | `FileReader` | `DESK.importSub()` IPC |
| **匯出字幕** | `URL.createObjectURL` 觸發下載 | `DESK.exportSub()` IPC 寫檔至磁碟 |
| **存/讀專案** | 下載檔案 | `DESK.saveProject()` / `loadProject()` IPC |
| **自動備份** | 每 3 分鐘觸發瀏覽器下載 | 每 3 分鐘寫入 `.subtool_AutoSave/` 子目錄 |
| **Video 安全性** | `webSecurity: true`（受 CORS 限制） | `webSecurity: false`（允許 `file://` 媒體） |

### `window.subtool`（Electron contextBridge）
由 `electron/preload.js` 透過 `contextBridge.exposeInMainWorld` 暴露，提供：

```
window.subtool = {
  isDesktop: true,
  openMedia()              → 系統開檔對話框，回傳路徑
  probe(path)              → ffprobe：duration/fps/video/audio 資訊
  stat(path)               → 檔案是否存在 + 大小
  fileURL(path)            → 本地路徑 → 可播放的 URL
  ingest({path,audio,...}) → 系統 ffmpeg：轉 proxy + 抽聲道 + 波形（單次多輸出）
  streamIngest({...})      → 邊轉邊播（快取機制：hash 比對，相同檔案秒開）
  waveAudio(path, dur)     → 抽取 8kHz mono WAV
  importSub(ext)           → 系統開檔（字幕）
  exportSub(name,b64,ext)  → 系統儲存（字幕）
  saveProject(name,b64)    → 系統儲存（.subtool）
  loadProject()            → 系統開檔（.subtool）
  writeProject(path,b64)   → 直接寫入指定路徑（自動備份用）
  readB64(path)            → 讀檔回 base64
  cleanupAudio(path)       → 刪除暫存音訊檔
  mpv: {                   → mpv 整合（僅在偵測到 mpv.exe 時可用）
    detect()               → 檢查 mpv 是否可用
    launch({src,bounds,audio}) → 啟動 mpv 嵌入播放
    play/pause/seek/rate/mute/quit/setBounds/onEvent/show
  }
}
```

### Electron 主程序（`electron/main.js`）關鍵行為
- **ffmpeg/ffprobe 偵測**：優先內建（`electron/ffmpeg/*.exe`），fallback 系統安裝或常見路徑
- **硬體加速**：嘗試 NVENC/QSV/AMF，fallback libx264；`-pix_fmt yuv420p` 確保瀏覽器相容
- **ingest 快取**：以 `MD5(path + size + mtime)` 為 key，命中則直接回傳已有檔案（秒開）
- **streamIngest 邊播邊轉**：先回傳 HLS 或分段 mp4 URL 供 `<video>` 播放，ffmpeg 在背景繼續處理；完成後 `desk:ingest-done` 事件載入音軌
- **tempFiles 清理**：程序退出時刪除所有暫存檔（`TMP = %TEMP%/subtool_cache`）

---

## 7. 關鍵流程說明

### 7.1 字幕渲染流程

字幕在兩個地方渲染：**字幕列表**（側欄 DOM）與**影片疊層**（`#videoSub` 絕對定位 div）。

#### 影片疊層渲染（`renderVideoSub`）
```
1. 取得當前播放時間 t = Media.displayTime()
2. 對每個可見軌道，篩選 c.start <= t <= c.end 的字幕
3. 依軌道 posPct（距底部百分比）計算垂直位置
4. 設定 #videoSub div 的 innerHTML（escapeHTML + \n → <br>）
```

#### mpv 模式字幕渲染（`refreshMpvSubs`）
```
1. 以 SubFormats.toASS(State.cues, fps, tracks, ...) 序列化全部字幕
2. base64 編碼後透過 IPC 傳給 Electron 主程序
3. 主程序呼叫 mpv.loadSubtitles(b64) → 寫入暫存 .ass → mpv --sub-file 載入
```
防抖 100ms 避免快速連續輸入時頻繁重建。

---

### 7.2 時間軸互動流程

#### 字幕區塊拖曳（move 模式）
```
mousedown on .cue-block
  → 計算所有被拖字幕的 {prevEnd, nextStart}（neighborBounds）
  → 計算磁吸目標陣列 snapTargets（播放點 + 所有其他字幕邊界 + 備忘時間點）
  → drag.mode = 'move'

mousemove
  → dt = (clientX 變化 + scroll 變化) / pxPerSec
  → 防重疊：限制 dt 在每條字幕的 [prevEnd-os, nextStart-oe] 範圍內
  → 磁吸：單選時嘗試起點或終點 snap
  → 軌道切換：trackFromY(clientY) 計算目標軌道
  → 僅更新 DOM style.left/width（不 renderAll，效能優化）

mouseup
  → sortCues()
  → emit('render:all')
  → recordHistory('移動字幕')
```

---

### 7.3 音訊混音流程

#### Web Audio 圖形
```
video element
  └→ createMediaElementSource
       └→ ChannelSplitter(2)
           ├→ GainNode(L) ──→ ChannelMerger → master GainNode → destination
           ├→ GainNode(R) ──→
           ├→ AnalyserNode(L)  ← 電平表用（不影響輸出）
           └→ AnalyserNode(R)

外部音檔 element
  └→ createMediaElementSource
       └→ ChannelSplitter(N)
           ├→ GainNode(ch0) → master
           ├→ ...
           └→ AnalyserNode(chN)

ffmpeg 抽取 buffer
  └→ AudioBuffer
       └→ createBufferSource（每次 play 重建）
            └→ GainNode → master
```

#### 靜音/獨奏邏輯（`applyGains`）
```
anySolo = tracks.some(t => t.solo && !t._srcHidden)
activeMix = 是否有可聽見的 mix 軌（element/buffer）

for each track:
  audible = anySolo ? track.solo : !track.muted
  gain.value = audible ? track.volume : 0

  if kind === 'native' && activeMix && !solo:
    gain.value = 0  ← mix 音軌存在時壓制原生音訊，避免雙重聲音

master.gain.value = State.muted ? 0 : 1
```

#### 音源切換（`switchSource`）
切換「影片原音」或「外部音檔 N」時，非目標音源的軌道設 `_srcHidden = true`，`applyGains` 將其 gain 設為 0。

---

### 7.4 匯入匯出流程

#### 匯入
```
importSub()
  → 取得文字（pickFile 或 DESK.importSub IPC）
  → 若無影片，彈窗詢問 FPS
  → detectSubFormat → 解析（parseSRT / parseASS / parseEncore / parseTXT）
  → convertLineBreaks（// 或 \\ → \n）
  → _openImportModal：選目標軌道（新增或現有）
  → snapTimeToFrame 對齊每條 start/end
  → 寫入 State.cues → sortCues → emit('render:all')
```

#### 匯出
```
showExportDialog()
  → 選格式（SRT/ASS/Encore/TXT）
  → 多軌：勾選要匯出的軌道
  → doExport(kind, cues, trackName)
    → 序列化（toSRT / toASS / toEncore / toTXT）
    → encodeUTF16LE（統一 UTF-16 LE + BOM 輸出）
    → Web: downloadBytes → 瀏覽器下載
    → Desktop: DESK.exportSub IPC → 系統另存對話框
```

---

### 7.5 I/O 上字幕流程

```
播放中或暫停
  → 按 I：setIn()
    → ensureProjectSaved()（首次編輯前）
    → 無選取：addCue(t, t+2, '', 0)（新建 2 秒空白字幕）
    → 有選取：c.start = t，若 end <= start 則 end = start + 0.5

  → 按 O：setOut()
    → c.end = t
    → 若 subMode（上字幕模式）：autoAdvanceSubMode()
      → 自動選取同軌下一條字幕
      → 最後一條完成後關閉 subMode
```

#### 上字幕模式（`State.subMode`）
適合「先建好空白字幕框，邊看邊標時間」的工作流：
1. 匯入純文字字幕（所有字幕 `timed=false`）
2. 開啟上字幕模式（`subModeBtn`）
3. 播放影片：看到字幕對應畫面時按 I → O
4. O 後自動跳下一條，直到全部完成

---

### 7.6 Undo/Redo 流程

```
任何狀態變更函式最後呼叫 recordHistory('動作描述')
  → History.snap()：structuredClone(cues + tracks + notes + fps)
  → 比對與前一步是否相同（JSON.stringify）
  → 不同：push 到 stack，hi++

Ctrl+Z → History.undo()
  → History.restore(hi-1)
    → structuredClone 還原 State.cues / tracks / notes
    → setFps（若影格率有變）
    → emit('render:all') + drawTimeline() + renderNotes()

Ctrl+Shift+Z → History.redo()
  → History.restore(hi+1)
```

歷史面板（`A` 鍵開關）顯示所有步驟，點擊可直接跳到任意步驟。

---

*文件由 Claude Code 根據原始碼自動分析整理，如有程式碼更新請同步維護此文件。*
