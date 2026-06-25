# CHANGELOG — SUB Tool

所有版本的重要變更紀錄，依時間倒序排列。

---

## [目前 / master] — 2026-06-25

### 新增
- 空專案可直接移動播放點（`seek()` 無影片時不再 clamp 至 0）
- 時間軸無影片無字幕時預設 10 分鐘可操作空間（`tlTotal()` 基底 600s）
- 啟動或新專案時自動建立「軌道 1」（`ensureTrackCount(1)`），不再需要手動新增
- 第一次載入影片或字幕時自動縮放至完整影片長度（`_firstLoad` + `zoomFitVideo()`）

### 文件
- 新增 `README.md`（專案入口說明）
- 新增 `CHANGELOG.md`
- 重寫 `ELECTRON_MAINTENANCE.md`（改為本專案實際架構，移除通用模板）
- `shortcuts.csv`、`#使用說明.md`、`#開發說明.md`、`#驗證說明.md`、`ARCHITECTURE.md` 全面對照程式碼重新查證

---

## [v2.8.0] — 2026-06-24

### 修復（程式碼審查 19 項）
- `_detectOverlaps`：改雙層掃描，修復長字幕包住多條短字幕時的漏報
- Web 自動備份：改存 `localStorage`（不再每 3 分鐘彈出下載對話框）
- ffmpeg.wasm CDN：優先 jsDelivr，fallback unpkg
- `Media.reset()`：清除 `_scrubEl` 子元素，修復跨檔案記憶體洩漏
- `extractAllAudio` ffmpeg FS：改 `try/finally`，確保失敗時清理虛擬 FS
- `_splitToChannelTracks` ID：改用遞增計數器，避免同毫秒碰撞
- `stopBufferSources`：`stop()` 後補 `disconnect()`，修復 AudioGraph 洩漏
- `History.record`：先做 O(1) 結構比對，再 fallback `JSON.stringify`，修復大量字幕時卡頓
- `drawTimeline` / `redrawTimeline`：拆分輕量版，減少播放路徑重繪開銷
- `mixer.js` 廢棄 analyser 參照：`reset()` 時呼叫 `clearMeterStrips()`
- `Wave.selectSource`：加 `myIdx` 快照防競爭條件
- `_bgAudioIngest` bail-out：清除 Audio 元素防背景預緩衝浪費
- `_durAdjCues`：改為接受 `scope` 參數，解除 DOM 緊耦合
- `sortCues`：加 `id` 次排序鍵，確保穩定排序
- `confirm()` 三處：改用 `openModal`，統一對話框風格
- `setTimeout(30ms)` 三處：改 `requestAnimationFrame`，符合瀏覽器渲染時序
- mpv bounds feeder：間隔從 1000ms 延長至 2000ms
- 大檔提示：500MB–1.6GB 與 > 1.6GB 給出不同說明
- `data.version || 1`：改明確檢查避免 `version: 0` 誤判

### FPS / 時碼一致性
- `encoreParts()`：提取為唯一「秒→時:分:秒:格」換算來源
- `fmtTick()`：改走 `encoreParts`，修復時間軸刻度與播放器時碼在 29.97 NDF 長時碼處差幾秒
- `nudge()`：改以 `displayTime()` 為基準，修復逐格跳兩格 / 退不動
- mpv `time-pos` handler：加 1.5 格抖動容忍死區，修復播放器比播放點多一格
- `pause` event：暫停時一併刷新 `tcCur/seekBar`，同源 `displayTime()`
- 新增 `FPS_時碼一致性.md`，記錄 6 大不變量與踩過的 3 個 Bug

---

## [v2.7.0] — 2026-06

### 修復
- JKL 最高速上限修正為 5×（每階 0.5×）
- `2`/`5` 鍵方向更正（`2` = 下一句, `5` = 上一句）
- 播放器 mpv 嵌入 Z 軸覆蓋順序
- 大型影音媒體快取鍵改為內容雜湊（SHA-1），跨電腦可共用快取

---

## [v2.6.0] — 2026-05

### 新增
- 單次讀取轉檔（single-pass multi-output）：MXF/ProRes 一次 ffmpeg 轉 proxy + 逐聲道音訊 + 波形
- GPU 硬體加速編碼（NVENC / QSV / AMF），fallback libx264
- 逐聲道音訊抽取 + 混音器電平表
- 快取機制：命中則秒開，key = 路徑 + 大小 + 前 1MB 雜湊
- mpv 嵌入視窗秒開（偵測到系統 mpv.exe 時啟用）
