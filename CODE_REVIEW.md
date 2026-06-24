# SUB Tool — Code Review 修復清單

**審查日期：** 2026-06-24  
**修復版本：** v2.8.0  
**Build 結果：** ✅ 0 錯誤、0 警告（`npm run build` 通過）

---

## 🔴 Critical（優先修復）

### #1 `_detectOverlaps` 漏報非相鄰重疊
**檔案：** `src/subtitles.js` → `_detectOverlaps()`  
**問題：** 舊邏輯只比較排序後的相鄰對（`sorted[i]` vs `sorted[i+1]`），當一條長字幕包住多條短字幕時，內部對完全漏報。  
**修法：** 改為雙層掃描：對每個 `sorted[i]`，向後掃直到 `sorted[j].start >= sorted[i].end`（已排序保證 break 正確），所有途中的 `j` 均記入重疊集合。

---

### #2 Web 自動備份每 3 分鐘觸發下載
**檔案：** `src/project.js` → `_autoSave()`  
**問題：** 瀏覽器版直接呼叫 `downloadBytes`，每 3 分鐘彈出一次儲存對話框，嚴重干擾工作流，且現代瀏覽器可能靜默封鎖。  
**修法：** 瀏覽器版改將備份存入 `localStorage`（`subtool_autosave_data / _name`），靜默更新，額度不足時靜默失敗並 `console.warn`。

---

### #3 ffmpeg.wasm CDN 使用不穩定的 unpkg
**檔案：** `src/media.js` → `loadFFmpeg()`  
**問題：** unpkg 偶爾出現延遲或 CORS 問題，導致整個音訊抽取功能故障。  
**修法：** 優先載入 jsDelivr，失敗時 fallback 至 unpkg；`corePath` 跟隨選擇的 base URL，確保 JS 與 WASM core 來自同一 CDN。

---

### #4 `Media.reset()` 未清除 `_scrubEl` 子元素
**檔案：** `src/media.js` → `reset()`  
**問題：** `scrubAudio()` 會在 `tr.el` 上掛載 `_scrubEl`（隱藏 `<video>`），`reset()` 只清除主 `el.src`，舊 `_scrubEl` 持續保存 media 資源，跨檔案開啟時累積記憶體洩漏。  
**修法：** 在 `this.tracks=[]` 之前，遍歷所有 `tr.el._scrubEl`，先 `src=''` 再設為 `null`。

---

### #5 `extractAllAudio` ffmpeg FS 未在失敗時清理
**檔案：** `src/media.js` → `extractAllAudio()`  
**問題：** 原本的 `ff.FS('unlink', ...)` 放在 try 區塊內，若中途拋出例外就完全跳過，下次執行時 ffmpeg 的虛擬 FS 殘留舊檔導致「file already exists」錯誤或記憶體洩漏。  
**修法：** 用 `try/finally` 包裝：`finally` 中無條件對 `in.media` 及所有 `a${i}.wav` 執行 `unlink`（各自 try/catch 忽略「不存在」錯誤）。同時將 `ff` 提升到外層作用域供 `finally` 存取。

---

### #6 `_splitToChannelTracks` ID 用 `Date.now()+i` 可能碰撞
**檔案：** `src/media.js` → `_splitToChannelTracks()`  
**問題：** 同毫秒內建立多條音軌時，`Date.now()+0, Date.now()+1, ...` 可能產生相同 ID（若 `Date.now()` 在循環中未推進），導致音軌 Map 覆蓋或 DOM key 衝突。  
**修法：** 模組頂層加入 `let _extTrackIdCounter = 0`，改用 `'ext'+(++_extTrackIdCounter)` 確保全域唯一遞增。

---

### #7 `stopBufferSources` 未呼叫 `.disconnect()`
**檔案：** `src/media.js` → `stopBufferSources()`  
**問題：** `AudioBufferSourceNode.stop()` 後若不 `disconnect()`，節點仍保持對 AudioGraph 的參照，`AudioBuffer` 無法被 GC 回收，造成長時間使用的記憶體洩漏。  
**修法：** `stop()` 後緊接 `disconnect()`，再設 `tr.srcNode=null`。

---

## 🟠 High

### #8 `History.record` 每次都做完整 JSON 序列化
**檔案：** `src/history.js` → `History.record()`  
**問題：** 每次鍵入字幕文字、移動時間軸滑桿都觸發 `JSON.stringify(newSnap)` 比對，字幕千條時對 `State.cues` 深層序列化成本高，在低端硬體上造成 UI 卡頓。  
**修法：** 先做 O(1) 結構比對（`cues.length / tracks.length / notes.length / fps / dropFrame`）；僅在結構完全相同時才 fallback 做完整 `JSON.stringify` 深層比對，結構有差異直接記錄跳過序列化。

---

### #9 `drawTimeline` 包含 `renderTrackRows` 被頻繁呼叫
**檔案：** `src/timeline.js`  
**問題：** `drawTimeline()` 每次均重建整個軌道列（`renderTrackRows`），但捲動 / 播放更新時其實只需要 ruler + wave + cue blocks + playhead。  
**修法：** 新增 `redrawTimeline()` 函式（`drawRuler + drawWave + renderCueBlocks + updatePlayhead`）並加入 export，提供給播放路徑等不需要重建軌道列的呼叫點使用。

---

### #10 `mixer.js` `_meterStrips` 持有廢棄 analyser 參照
**檔案：** `src/mixer.js`、`src/media.js`  
**問題：** `Media.reset()` 清空 `this.tracks` 後，`_meterStrips` 仍持有舊 analyser 物件的參照，`rafLoop` 中 `updateMeters()` 繼續對廢棄節點讀取，造成潛在記憶體洩漏及讀取已解構物件。  
**修法：** `mixer.js` 新增 `clearMeterStrips()` 函式並 export；`media.js` import 後在 `reset()` 的 `this.tracks=[]` 之後立即呼叫。

---

### #11 `Wave.selectSource` 競爭條件
**檔案：** `src/media.js` → `Wave.selectSource()`  
**問題：** 連續快速切換音源時，第二個非同步請求可能比第一個先完成，但第一個隨後覆蓋 `this.peaks`，最終顯示錯誤波形。  
**修法：** 在進入 async 流程時快照 `const myIdx = idx`，每個 `await` 後檢查 `this.srcIdx !== myIdx`，若已切換則直接 `return` 丟棄舊結果。

---

### #12 `_bgAudioIngest` 版本中斷時未清理 Audio 元素
**檔案：** `src/media.js` → `_bgAudioIngest()`  
**問題：** bail-out 檢查 `this._bgVersion !== myVer` 直接 `return`，已建立的 `Audio` 元素 (`els`) 繼續在背景預緩衝新媒體，浪費頻寬並佔用 HTTP 連線。  
**修法：** bail-out 前對 `els` 中每個元素執行 `el.src = ''`，立即停止瀏覽器的背景載入。

---

## 🟡 Medium

### #13 `_durAdjCues` 隱含讀取 DOM
**檔案：** `src/subio.js` → `_durAdjCues()`  
**問題：** 函式直接讀取 `$('tcShiftSel').value`，與 DOM 結構緊耦合，難以測試，也無法從非 DOM 環境呼叫。  
**修法：** 改為接受 `scope` 參數；呼叫端 `applyDurAdjTc` / `applyDurAdjPct` 各自傳入 `$('tcShiftSel').value`，職責明確分離。

---

### #14 `sortCues` 排序不穩定
**檔案：** `src/subtitles.js` → `sortCues()`  
**問題：** 兩條起點相同的字幕每次排序結果不確定，可能在 undo/redo 或 renderSubList 時造成視覺閃爍。  
**修法：** 加入 `id` 作次排序鍵：`a.start - b.start || (a.id < b.id ? -1 : 1)`，確保同起點字幕順序完全確定。

---

### #15 `confirm()` 用於多處破壞性確認
**檔案：** `src/timeline.js` → `removeTrack()`、`src/notes.js` → `clearAllNotes()` / `_showNoteCtx()`  
**問題：** 原生 `confirm()` 在 Electron 中可能被截取（樣式不一致或無法彈出），且與應用程式整體 UI 風格不符。  
**修法：** 三處全改用 `openModal` / `closeModal`，以應用程式內建的模態對話框替代。`removeTrack` 的實際刪除邏輯提取為 `doRemove()` 閉包，由模態「確定」按鈕呼叫。

---

### #16 `setTimeout(30ms)` 在三處用於 DOM focus
**檔案：** `src/subtitles.js` → `addCueAfter()`、`addCueRelative()`、`splitCueAtCursor()`  
**問題：** 30ms 為魔術數字，`emit('render:all')` 已同步更新 DOM，30ms 的延遲在低端硬體上可能仍不足（導致 `querySelector` 找不到元素），在高端硬體上則造成不必要延遲。  
**修法：** 三處統一改為 `requestAnimationFrame(...)`，確保瀏覽器完成本幀繪製後再 focus，符合瀏覽器渲染時序。

---

## 🔵 Low

### #17 mpv bounds feeder 間隔過短（1000ms）
**檔案：** `src/media.js` → `_startMpvBoundsFeeder()`  
**問題：** 每秒一次的 IPC 呼叫只是為了更新視窗邊界（拖動面板時的安全網），對於非動畫操作頻率過高，增加不必要的 Electron IPC 負擔。  
**修法：** 改為 2000ms，減少 IPC 呼叫次數。

---

### #18 大檔案提示未區分可處理範圍
**檔案：** `src/media.js` → `loadVideoFile()`  
**問題：** 500MB 以上的檔案統一顯示同一條提示，但 500MB–1.6GB 的檔案仍可被 ffmpeg.wasm 完整處理（1.6GB 才是上限），過於模糊。  
**修法：** 判斷 `file.size <= FFMPEG_MAX_BYTES`：若在 500MB–1.6GB 區間提示「可另載入音訊檔取得完整波形」，超過 1.6GB 則給出不同提示。

---

### #19 `data.version || 1` 誤判 `version: 0`
**檔案：** `src/project.js` → `Project.apply()`  
**問題：** `data.version || 1` 在 `version: 0` 時會回傳 1（0 是 falsy），若未來格式有版本 0 就會被錯誤當成 v1 解析。  
**修法：** 改為明確檢查：`data.version === undefined || data.version === null || data.version === 1`，語意清晰且不受 falsy 影響。

---

## 驗證結果

```
> npm run build
vite v5.4.21 building for production...
✓ 25 modules transformed.
dist/index.html  204.62 kB │ gzip: 73.88 kB
✓ built in 242ms
```

**全部 19 項均已修復，Build 0 錯誤、0 警告。**

---

*所有修改均為外科手術式，未重構無關邏輯，未新增功能，未更動 API 介面。*
