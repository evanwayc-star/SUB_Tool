# SUB_Tool 程式碼優化審查報告

在不更動任何程式碼的前提下，我對專案的原始碼進行了全面的架構與效能審查。以下是幾個可以顯著提升「大型專案流暢度」、「穩定性」與「未來維護性」的優化建議方向：

## 1. 渲染效能 (Rendering & DOM Performance)
目前系統在變更字幕或狀態時，高度依賴 `renderAll()` 進行全域刷新。

* **過度渲染 (Over-rendering)**：
  目前只要執行 `renderAll()`，就會重新建構整個字幕列表 (`renderSubList`)、時間軸區塊 (`renderCueBlocks`) 與影片預覽字幕 (`renderVideoSub`)。若載入上千條字幕，頻繁使用 `innerHTML` 替換會導致嚴重的 Layout Trashing 與卡頓。
  * **💡 建議優化**：導入**虛擬捲動 (Virtual List)** 或**局部更新 (DOM Patching)** 機制。針對列表，只需渲染可視範圍內的 `sub-row`；針對更新，只需抽換有變動的那單一列，而非清空重繪。
* **事件綁定記憶體洩漏風險**：
  在 `buildSubRow` 中，每次重新建立列都會附加 `addEventListener`。如果列表頻繁被重繪，舊 DOM 雖然被移除，但若有參照殘留可能導致 Memory Leak。
  * **💡 建議優化**：改用**事件代理 (Event Delegation)**。將點擊與鍵盤事件統一綁定在 `#sublist` 容器上，透過 `e.target.closest` 判斷點擊目標，能大幅減少記憶體開銷。

## 2. 迴圈與搜尋效能 (Algorithmic Efficiency)
* **影格更新迴圈 (requestAnimationFrame)**：
  在 `app.js` 的 `rafLoop` 中，每秒執行 60 次的 `State.cues.find(...)` 來尋找目前時間區間內的 active 字幕。在數千條字幕的陣列中做 O(N) 的線性搜尋是非常消耗 CPU 資源的。
  * **💡 建議優化**：利用**快取索引 (Cached Cursor)**。紀錄上一次搜尋到的字幕 index，在下一幀時優先檢查該字幕與其相鄰的字幕是否符合時間點，將時間複雜度降至 O(1)。

## 3. 記憶體管理 (Memory Management & Audio Processing)
* **音頻解碼 (Web Audio API)**：
  對於沒有經過 ffmpeg 預先處理的外部音檔，會使用 `Media.ctx.decodeAudioData` 來解碼整個音訊陣列以計算波形 (`Wave.compute(ab)`)。如果匯入的是 1~2 小時長的 WAV 檔，解碼後的 `Float32Array` 會佔用巨大的記憶體，非常容易導致瀏覽器 Out Of Memory (OOM) 崩潰。
  * **💡 建議優化**：在 Electron 桌面版模式下，應完全依賴 `ffmpeg` 在背景直接抽取並運算 Waveform 峰值資料（只輸出時間與振幅的輕量級 JSON 數據），避免將整個音檔讀入主執行緒的 Web Audio API 記憶體中。

## 4. 架構與耦合度 (Architecture & Modularity)
* **循環依賴 (Cyclical Dependencies) 與高耦合**：
  雖然專案已經拆分了多個模組（如 `subtitles.js`, `app.js`, `timeline.js`），但模組間經常直接互相呼叫對方的函數（例如 `app.js` 呼叫 `renderSubList`，而 `subtitles.js` 又匯入 `renderAll` 呼叫回去）。這種高度依賴狀態變數 (`State`) 與渲染函數的寫法，在功能增加後會變得難以維護。
  * **💡 建議優化**：導入**事件驅動架構 (Event Emitter)** 或**輕量狀態管理 (Pub/Sub)**。當 `State` 改變時，只需發送 `Event.emit('cues-updated')`，讓各個 UI 模組各自監聽並決定是否要重繪自己，藉此解耦模組。

## 5. 錯誤防呆與大檔案處理 (Error Handling & IO)
* **大型字幕檔匯入**：
  若拖曳匯入極大的 TXT 或 SRT 檔案，主執行緒的字串正則解析與 `renderSubList` 會造成畫面短暫凍結。
  * **💡 建議優化**：將解析過程放入 `Web Worker` 執行，或使用分段處理 (`requestIdleCallback`) 讓介面保持滑順。

---
> [!NOTE]
> 以上是針對現有架構的綜合審查。如果需要實際進行優化，我們可以分階段來進行，例如優先處理 **「事件代理與列表渲染效能」**，或是 **「解除 rafLoop 的效能瓶頸」**。您想先從哪一個部分開始，或是對哪些優化方向特別感興趣呢？
