# FPS / 時碼一致性說明（給維護者）

> 主題：影格率（FPS）與時碼（timecode）在各處顯示為何要一致、如何保證一致。

這份文件解釋本工具裡所有跟「影格 / 時碼」有關的設計原則與踩過的坑。
**改動任何牽涉時碼顯示、播放點、seek、逐格的程式碼前，請先讀完本文。**

在程式碼裡，所有相關關鍵點都標了可搜尋的標記：

```
FPS-SYNC
```

> 想一次找到全部標記：用編輯器全域搜尋 `FPS-SYNC`。核心位置包含
> `time.js / media.js / loaders/media-loader.js / timeline-renderer.js / transport-controller.js / pointer-seek-control.js / timeline-transport.js / speech-recognition.js / app.js`；
> 不要手動維護「共幾處」這種會隨程式演進失真的數字。

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

維護時請把這 8 條當鐵律。違反任何一條都會造成「差一格 / 對不上刻度」。

### (I1) FPS 一律「實測」，**絕不依檔名判斷**

- 網頁版：`detectFpsWeb()`（`media.js`）用 `requestVideoFrameCallback` 量真實影格時間戳的中位數。**量到的值不可先 `Math.round()` 取整**——整數化會把 29.97→30、23.976→24，直接把 NTSC 分數影格率毀掉（v4.4.0 修復）；原始實測值直接交給 `snapFps()`。
- 桌面版：`DESK.probe()`（ffprobe）→ `info.video.fps`。
- 都會經 `snapFps()` 對齊到允許集合 `[23.976, 24, 25, 29.97, 30]`，存進 `State.fps` / `State.dropFrame`。
- **檔名可能寫錯**（真實案例：檔名標 `24FPS…30P`，實際是 29.97fps）。檔名只能當「線索」，不可當依據。

### (I1b) `getExactFps()` 的容差必須 **< 0.024**

- `getExactFps(fps)`（`time.js`）把 `State.fps` 的標稱值換成精準分數（29.97 → 30000/1001 等），所有數影格運算都用它。
- 24 與 23.976 只差 **0.024**、30 與 29.97 只差 0.03。容差一旦 ≥ 0.024，整數影格率就會被誤判成 NTSC 分數影格率——v4.3.1 曾把容差放寬到 0.05，造成**所有 24/30fps 專案時碼每小時漂移約 3.6 秒**（v4.4.0 修復，容差定為 **0.01**）。
- 0.01 已足夠涵蓋 ffprobe/mpv 回報的實測值（29.97002997、23.976023976、23.98），不可再放寬；`tests/time.test.js` 有守門測試。

### (I2) 「秒 → 時:分:秒:格」只有一個換算來源：`encoreParts()`

- 位於 `time.js`。`secToEncore()`（播放器 `tcCur`、字幕列表、匯出）與 `timeline-renderer.js` 的 `fmtTick()`（時間軸刻度）**都呼叫它**。
- **不要**在任何地方自己用 `Math.floor(s/3600)…` 拼時碼。曾經 `fmtTick` 這樣做，導致時間軸刻度顯示「真實秒數」而播放器顯示「數影格時碼」，在 1:33 處兩者差約 5 秒（見第 4 節 Bug A）。

### (I3) 影格格網只有一個：`snapTimeToFrame()`

- 位於 `time.js`。`seek()`、`pause()`、時間軸拖曳（`timeline-renderer.js` 的 `snapFrame`）、逐格步進都用它對齊。
- 確保播放點永遠落在整格、且與刻度同格。
- ASS 的 Start/End 只有百分秒；`secToASS()` 必須直接向下表示原秒數，**不可**自行減半格後再截斷。
  否則 29.97 的自產 ASS 回匯、再吸附格網時會穩定退到前一格。自產檔的精確影格由中繼資料保留。

### (I4) 「靜止讀數」必須同源於 `displayTime()`，**不可直接讀原始播放時間**

- `Media.displayTime()`（`media.js`）是**權威播放位置**：
  - 暫停時回傳 `_lastSeekTime`（已對齊影格）。
  - 播放中才回傳 `vTime()`（原始時間，為了平滑移動）。
- 播放器時碼 `tcCur`、時間軸播放點 `updatePlayhead()`、`seekBar` 這三個**靜止讀數必須全部用 `displayTime()`**。
- **不可**直接用 `video.currentTime` 或 mpv 的 `e.data`：seek 後瀏覽器 / mpv 會把實際位置「沉降」到相鄰格，原始時間經 `secToEncore` 進位就會比播放點多一格（見 Bug C）。
- 純字幕專案沒有 HTML video／mpv 的原生 `seeked` 可接手；`Media.seek()` 完成虛擬時間跳轉後仍須發出統一的 `mpv:seeked` 通知，讓字幕預覽、播放點與備註立即讀回同一個 `displayTime()`。

#### (I4a) 播放目標不能冒充實際呈現位置

- `Media.requestPresentation()` 的輸入是等待呈現的時間軸目標；解碼完成前不得先覆蓋 `_lastSeekTime`。
- HTML video 以 `requestVideoFrameCallback` 的 `mediaTime`、mpv 以同一請求確認後的 per-frame `time-pos`
  （播放中另須 `playback-restart`）、WebCodecs 以所有可見圖層成功 `drawImage()` 的來源時間戳，作為呈現完成證據。
- mpv 播放中的 `time-pos` 必須和該請求的 `playback-restart` 配對；暫停中的精準定位不會先送 restart，
  此時以 IPC 指令已確認且 `time-pos` 命中目標為準。若目標就是目前畫格而沒有新的 property-change，
  host 必須主動讀回 `time-pos`；兩種情況都不得用 seek 前的舊位置完成請求。
- 倒帶只保留最新尚未送出的目標，避免舊 seek 佇列讓畫面長時間追趕過期位置。
- 一般 seek 後立刻按播放時，play/pause 只先更新為最新意圖；HTML5／mpv／WebCodecs 尚未回報實際畫格前，
  不得啟動 presenter、片段推進或音訊 drift correction。等待中再按暫停時，晚到畫格只能完成靜止呈現。

### (I5) 逐格步進以 `displayTime()` 為基準

- `nudge()`（`keyboard.js`）用 `Media.displayTime() + d`，**不是** `vTime() + d`。
- 因為 `vTime()` 帶有瀏覽器沉降的浮點 ε，`+1格` 後再 `round` 會被放大成跳兩格 / 退不動（29.97 尤甚，見 Bug B）。
- Windows mpv host 對外仍只接受**來源時間**，但 IPC 實作要設定 `time-pos`，不可改回連續送 `seek absolute`。mpv 的 `seek` command 會刻意排入舊畫面的顯示等待，快速送出 ±1／±2 格時可能讓最新目標額外等約 0.3 秒；`time-pos` setter 仍是精準 absolute 定位，且可立即接手最新目標。
- 單次逐格的呈現完成容差必須 **< 0.5 格**。一般跳轉可容忍 1.5 格的播放器沉降，但目標只差一格時，該容差會讓「目前舊畫格」也落在成功範圍內，造成方向鍵偶爾看似沒動。
- 連續逐格已有更新的 pending 目標時，較早畫格即使真的呈現完成，也不可再 commit 回權威播放點；否則下一次方向鍵會從被蓋回的舊格計算，出現按鍵少走一格或反跳。

### (I6) 不可用「原始播放時間」覆蓋權威值 `_lastSeekTime`

- mpv 暫停時會持續回報 `time-pos`（原始時間，可能偏離格網半格多）。
- 處理時：若只是 seek 後的沉降抖動（與 `_lastSeekTime` 相差 **< 1.5 格**）→ **維持** `_lastSeekTime`；
  只有大幅變動（例如在 mpv 視窗內拖拉）才 `snapTimeToFrame` 並更新 `_lastSeekTime`。
- 若用原始時間覆蓋 `_lastSeekTime`，會把 (I3)(I5) 的精度毀掉（seek 目標被拉偏一格）。

### (I7) 影音解除連結後，所有片段邊界仍是時間軸時間

- 已解除的音訊素材有自己的 `offset / in / out`，但鍵盤 `↑ / ↓`、切割與匯出都必須以**時間軸時間**計算邊界；不可使用該 AudioElement 的 `currentTime` 當時間軸位置。
- 同一素材的來源時間只用於播放／解碼；`timelineTime = offset + (sourceTime - in)` 仍是唯一跨影片、外部音檔與字幕的共同座標。這讓音訊可移到影片外、純音訊專案仍有正確播放點與時碼。

### (I8) 監看 TC 與燒入 TC 分工，但兩者都要以專案時碼為準

- 播放器 `TC` 是監看 overlay，`video-renderer.js renderTimecodeWatermark()` 必須使用 `Media.displayTime()`，一般預覽由 DOM 顯示、mpv 預覽由透明 guide 顯示；絕不能各自讀 `video.currentTime`／mpv 原始事件。
- 匯出勾選「壓入時間碼浮水印」時，`export-job-builder.js buildExportJobs()` 從已凍結 submission 的 `timelineStart` 產生 `timelineStartTimecode`。這表示輸出第一格顯示專案的 In 時碼，並非強制從 `00:00:00:00` 起算。
- 監看 TC 是 config 偏好，不隨專案存檔也不會自動燒入；燒入 TC 只屬於那一次影片輸出，WAV 不適用。

---

## 3. 各關鍵點對照表

`FPS-SYNC` 標記放在最容易破壞不變量的計算與狀態邊界；下表也列出直接消費這些結果的入口，
因此不保證每一列本身都有該字串。

| 檔案 | 位置 | 作用 | 對應不變量 |
|------|------|------|-----------|
| `time.js` | `encoreParts()` | 唯一的「秒→時碼分量」換算 | I2 |
| `time.js` | `secToASS()` | ASS 百分秒不預先位移；回匯可回同一影格 | I3 |
| `time.js` | `snapTimeToFrame()` | 唯一的影格格網 | I3 |
| `speech-recognition.js` | `insertAsrSubtitles(requireValidTimes)` | 文本匹配寫入前吸附專案格網；無效／重疊行保留為 `timed:false`，不可替它吸附或偽造時間碼 | I3 |
| `media.js` | `detectFpsWeb()` 區塊 | 實測 FPS（非檔名） | I1 |
| `media.js` | `displayTime()` | 權威播放位置 | I4 |
| `media.js` | `seek()` 的 snap／純字幕通知 | seek 對齊影格；無播放器時仍通知預覽讀回 `displayTime()` | I3, I4 |
| `media.js` | `requestPresentation()` | 將時間軸目標映射給目前 presenter；收到實際畫格後才提交權威位置 | I3, I4, I4a |
| `pointer-seek-control.js` | `requestPointerSeek()` | 滑鼠互動傳入時間軸時間，播放狀態處理後仍統一交給 `Media.seek()` 吸附影格 | I3, I4 |
| `media.js` | `pause()` 的 snap | 暫停點對齊影格 | I3 |
| `media.js` | mpv `time-pos` handler | 暫停時同源同格 + 抖動容忍 | I4, I6 |
| `loaders/media-loader.js` | 原生 `seeked`／mpv per-frame `time-pos` | 普通 seek 對齊；mpv 播放中另與 `playback-restart` 配對，暫停中以 command ack + 目標 `time-pos` 提交 | I3, I4, I4a |
| `transport-controller.js` | `nudge()` | 逐格步進以權威值為基準，並要求小於半格的呈現容差 | I5 |
| `shuttle-runtime.js` | `ReverseShuttleSession` | elapsed time × 倍率 × 精確 FPS 產生最新倒帶目標；持續監看原生實際呈現進度 | I3, I4a, I5 |
| `media-presentation-core.js` | `createMediaPresentationSession()` | 同時一個 in-flight、只保留最新 pending，且舊呈現不可覆寫更新目標；同一 session 擁有 WebCodecs takeover、合成畫格 waiter、一般 seek 的最新播放意圖、取消與 reset | I4a, I5 |
| `decode/player.js` | WebCodecs 呈現回報 | 所有可見圖層完成繪製後回報各自實際來源時間 | I4a |
| `notes.js` | `addNote()` | 備註時間取自 `displayTime()` | I4 |
| `timeline-renderer.js` | `fmtTick()` | 刻度標籤走 `encoreParts` | I2 |
| `app.js` | `timeupdate` handler | 三讀數同源 `displayTime()` | I4 |
| `app.js` | `pause` event | 暫停時刷新時碼/seekBar 同源 | I4 |
| `app.js` | `fps:changed`／原生 `seeked` | 時碼、監看 TC、備註高亮同讀 `displayTime()` | I4 |
| `sequence.js` | `timedRangesForSource()` | live ASS 先以時間軸篩選、最後才轉來源時間 | I4 |
| `video-renderer.js` | `renderTimecodeWatermark()` | DOM／mpv guide 監看 TC 讀 `displayTime()` | I4, I8 |
| `export-job-builder.js` | `buildExportJobs()` | 從凍結的輸出 In 產生交付用 TC 起點 | I2, I8 |

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

### Bug D — 播放器提早一格顯示字幕（與拖曳磁吸產生的一格誤差）

- **現象**：明明字幕列表與時間軸上標示為 `02:03:54:13`，但播放器時間在 `02:03:54:12` 時就已經渲染出字幕。且拖曳時間軸設定 In 點時，會產生 1 格偏移。
- **原因**：
  - 過去判斷字幕是否顯示採用小數浮點運算 `(t + halfFrame) >= c.start`，在浮點精度下會引發邊界誤判，造成提早顯示。
  - 舊時間軸實作的磁吸範圍過大（20px），且之前使用了未經 NTSC 分數修正的 `Math.round(t*29.97)`。
- **修法**：
  - 全面導入 **SMPTE NTSC 精確分數**（如 `30000/1001` 代替 `29.97`）。
  - `renderVideoSub` 完全捨棄浮點比較，直接將時間與字幕轉為精確的**整數影格座標 (Frame Index)** 後再比較（`currentFrame >= startFrame`）。
  - 將所有 `snapFrame` 邏輯統一由 `time.js` 的 `snapTimeToFrame` 處理，並將磁吸範圍縮小為 8px（且允許按住 `Alt` 暫時取消磁吸）。

### Bug E — 純字幕專案點選比對字幕後，時碼改了但預覽畫面沒有更新

- **現象**：沒有匯入影音時，從字幕比對視窗點選一句字幕，播放點會跳到正確時間，但播放器字幕仍停在上一句。
- **原因**：虛擬時間軸 seek 沒有 HTML video／mpv 的原生事件可觸發後續重繪。
- **修法**：`Media.seek()` 的無媒體分支在更新虛擬時間後主動送出統一 `mpv:seeked` 通知；所有預覽消費者仍從 `displayTime()` 讀取權威位置（I4）。

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
