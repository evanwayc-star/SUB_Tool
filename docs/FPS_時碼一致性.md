# FPS / 時碼一致性說明（給維護者）

> 版本：對應 v2.8.0 之後｜主題：影格率（FPS）與時碼（timecode）在各處顯示為何要一致、如何保證一致。

這份文件解釋本工具裡所有跟「影格 / 時碼」有關的設計原則與踩過的坑。
**改動任何牽涉時碼顯示、播放點、seek、逐格的程式碼前，請先讀完本文。**

在程式碼裡，所有相關關鍵點都標了可搜尋的標記：

```
FPS-SYNC
```

> 想一次找到全部關鍵點：用編輯器全域搜尋 `FPS-SYNC`（目前約 12 處，分布於 5 個檔案：
> `time.js / media.js / timeline.js / keyboard.js / app.js`）。

---

## 1. 名詞與背景

| 名詞 | 意義 |
|------|------|
| **牆鐘秒數（wall-clock seconds）** | 真實經過的秒數，例如 `video.currentTime`、`mediaTime`。程式內部一律用「秒（浮點）」當基準。 |
| **時碼（timecode）** | 給人看的 `時:分:秒:格`，例如 `01:31:08:13`。由「秒」換算而來。 |
| **影格格網（frame grid）** | 第 N 格所對應的秒數 = `N / fps`。把任意秒數「對齊到最近格」就是 `snapTimeToFrame()`。 |
| **NDF（Non-Drop-Frame）** | 非丟幀時碼。每秒固定數 0…(fps-1) 格。 |
| **DF（Drop-Frame）** | 丟幀時碼，**僅適用 29.97fps**，分隔符用 `;`。用「每分鐘丟兩格、每十分鐘不丟」的規則讓時碼≈牆鐘。由 `State.dropFrame` 決定。 |

### 1.1 為什麼 29.97 非 DF 的時碼會「越走越慢」

29.97fps 非 DF 時碼是**數影格**：每數到 30 格才進一秒，但真實一秒只有 29.97 格。
於是時碼秒數會比牆鐘秒數**慢約 0.1%**：

- 1 小時 ≈ 慢 3.6 秒
- 1 小時 33 分 ≈ 慢約 5.5 秒

所以同一個牆鐘位置，**播放器時碼**（數影格）會顯示得比「真實秒數換算」小。
**這是正常、且是業界標準行為**（Premiere、各 NLE 同樣如此）。要讓時碼≈牆鐘，才需要切到 DF。

> 既然會漂移，**各處顯示就必須用同一套換算**，否則同一位置會顯示成不同時碼 → 見第 2 節。

---

## 2. 核心不變量（Invariants）★ 最重要

維護時請把這 6 條當鐵律。違反任何一條都會造成「差一格 / 對不上刻度」。

### (I1) FPS 一律「實測」，**絕不依檔名判斷**

- 網頁版：`detectFpsWeb()`（`media.js`）用 `requestVideoFrameCallback` 量真實影格時間戳的中位數。
- 桌面版：`DESK.probe()`（ffprobe）→ `info.video.fps`。
- 都會經 `snapFps()` 對齊到允許集合 `[23.976, 24, 25, 29.97, 30]`，存進 `State.fps` / `State.dropFrame`。
- **檔名可能寫錯**（真實案例：檔名標 `24FPS…30P`，實際是 29.97fps）。檔名只能當「線索」，不可當依據。

### (I2) 「秒 → 時:分:秒:格」只有一個換算來源：`encoreParts()`

- 位於 `time.js`。`secToEncore()`（播放器 `tcCur`、字幕列表、匯出）與 `timeline.js` 的 `fmtTick()`（時間軸刻度）**都呼叫它**。
- **不要**在任何地方自己用 `Math.floor(s/3600)…` 拼時碼。曾經 `fmtTick` 這樣做，導致時間軸刻度顯示「真實秒數」而播放器顯示「數影格時碼」，在 1:33 處兩者差約 5 秒（見第 4 節 Bug A）。

### (I3) 影格格網只有一個：`snapTimeToFrame()`

- 位於 `time.js`。`seek()`、`pause()`、時間軸拖曳（`timeline.js` 的 `snapFrame`）、逐格步進都用它對齊。
- 確保播放點永遠落在整格、且與刻度同格。

### (I4) 「靜止讀數」必須同源於 `displayTime()`，**不可直接讀原始播放時間**

- `Media.displayTime()`（`media.js`）是**權威播放位置**：
  - 暫停時回傳 `_lastSeekTime`（已對齊影格）。
  - 播放中才回傳 `vTime()`（原始時間，為了平滑移動）。
- 播放器時碼 `tcCur`、時間軸播放點 `updatePlayhead()`、`seekBar` 這三個**靜止讀數必須全部用 `displayTime()`**。
- **不可**直接用 `video.currentTime` 或 mpv 的 `e.data`：seek 後瀏覽器 / mpv 會把實際位置「沉降」到相鄰格，原始時間經 `secToEncore` 進位就會比播放點多一格（見 Bug C）。

### (I5) 逐格步進以 `displayTime()` 為基準

- `nudge()`（`keyboard.js`）用 `Media.displayTime() + d`，**不是** `vTime() + d`。
- 因為 `vTime()` 帶有瀏覽器沉降的浮點 ε，`+1格` 後再 `round` 會被放大成跳兩格 / 退不動（29.97 尤甚，見 Bug B）。

### (I6) 不可用「原始播放時間」覆蓋權威值 `_lastSeekTime`

- mpv 暫停時會持續回報 `time-pos`（原始時間，可能偏離格網半格多）。
- 處理時：若只是 seek 後的沉降抖動（與 `_lastSeekTime` 相差 **< 1.5 格**）→ **維持** `_lastSeekTime`；
  只有大幅變動（例如在 mpv 視窗內拖拉）才 `snapTimeToFrame` 並更新 `_lastSeekTime`。
- 若用原始時間覆蓋 `_lastSeekTime`，會把 (I3)(I5) 的精度毀掉（seek 目標被拉偏一格）。

---

## 3. 各關鍵點對照表（搜尋 `FPS-SYNC`）

| 檔案 | 位置 | 作用 | 對應不變量 |
|------|------|------|-----------|
| `time.js` | `encoreParts()` | 唯一的「秒→時碼分量」換算 | I2 |
| `time.js` | `snapTimeToFrame()` | 唯一的影格格網 | I3 |
| `media.js` | `detectFpsWeb()` 區塊 | 實測 FPS（非檔名） | I1 |
| `media.js` | `displayTime()` | 權威播放位置 | I4 |
| `media.js` | `seek()` 的 snap | seek 對齊影格 | I3 |
| `media.js` | `pause()` 的 snap | 暫停點對齊影格 | I3 |
| `media.js` | mpv `time-pos` handler | 暫停時同源同格 + 抖動容忍 | I4, I6 |
| `keyboard.js` | `nudge()` | 逐格步進以權威值為基準 | I5 |
| `timeline.js` | `fmtTick()` | 刻度標籤走 `encoreParts` | I2 |
| `app.js` | `timeupdate` handler | 三讀數同源 `displayTime()` | I4 |
| `app.js` | `pause` event | 暫停時刷新時碼/seekBar 同源 | I4 |

---

## 4. 已修過的 Bug 案例（避免再犯）

### Bug A — 時間軸刻度與播放器時碼差幾秒（越後面差越多）

- **現象**：1:33 處播放器顯示 `01:33:13`，時間軸刻度顯示 `1:33:18`，差約 5 秒。
- **原因**：`fmtTick` 自己用「真實秒數」拼時碼，而播放器用 `secToEncore`（數影格）。29.97 非 DF 兩者本就漂移。
- **修法**：`fmtTick` 改走 `encoreParts`（I2）。整數 fps 不受影響；29.97 漂移情況兩者一致。

### Bug B — 逐格：右鍵跳兩格、左鍵退不動

- **現象**：在高時碼（如 01:23:15）按右鍵一次前進兩格，按左鍵又彈回原位。
- **原因**：`nudge` 用 `vTime()`（原始 `video.currentTime`），seek 後瀏覽器把它落在「下一格」≈ 超前一格；`±1格` 再 `round` 被放大。
- **修法**：`nudge` 改用 `displayTime()`（I5）。在自己的整數格網上 ±1，`seek` 的 snap 變冪等。

### Bug C — 播放器時碼比時間軸播放點多一格（與 FPS 正確與否無關）

- **現象**：正確的 29.97 NDF 專案、未載入字幕，播放器 `01:26:21:04` vs 播放點 `1:26:21:03`。
- **原因**：
  - mpv 模式：`tcCur` 用 mpv 回報的**原始時間** `e.data`，而播放點用 `displayTime()`（已對齊格）。seek 後 mpv 沉降約 0.6 格 → `secToEncore` 進位多一格。
  - 網頁模式：`pause` 事件只搬了播放點，沒刷新 `tcCur`，殘留播放中的未對齊值。
- **修法**：
  - mpv `time-pos`：暫停時用「抖動容忍」策略（I6）——沉降抖動維持 `_lastSeekTime`，大幅變動才吸附；顯示與播放點同源。
  - `app.js` `pause` 事件：暫停時把 `tcCur`/`seekBar` 一併刷新為 `displayTime()`（I4）。

---

## 5. 維護指引（新增功能時）

- **要顯示任何時碼** → 一定呼叫 `secToEncore(秒, State.fps, State.dropFrame)`，不要自己拼字串。
- **要取「目前播放位置」做顯示 / 計算** → 用 `Media.displayTime()`，不要用 `video.currentTime` / `_mpvTime` / `e.data`。
- **要把某個秒數變成「精準一格」** → 用 `snapTimeToFrame(秒, State.fps, State.dropFrame)`。
- **要做逐格 / 位移** → 以 `Media.displayTime()` 為基準加減 `n/State.fps`，再交給 `Media.seek()`（seek 內部會再 snap）。
- **需要 FPS** → 讀 `State.fps` / `State.dropFrame`；它們由實測（I1）或使用者下拉選單（`fpsSel` → `setFps()`）決定。**永遠不要從檔名推斷。**
- 加完新的時碼相關程式碼，**請在該處補上 `FPS-SYNC` 標記**並視需要更新本文件第 3 節對照表。

---

## 6. 快速驗證（不需真實影片）

換算邏輯可純數值驗證（共用 `encoreParts`，故各處必然一致）。例如在 DevTools／preview eval 重現第 4 節各案例：對同一秒數比較
`secToEncore(t,fps,df)`（播放器/列表/匯出）與 `fmtTick` 走的 `encoreParts`（刻度）是否相同；以及
逐格時 `displayTime()`-基準 vs `vTime()`-基準的差異。三個案例皆已用此法驗證通過。

> 真正涉及 mpv 沉降的視覺行為，需在桌面版載入實際影片、seek 後比對「播放器時碼 == 時間軸播放點」。
