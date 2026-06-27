# SUB Tool 深度代碼審查與重構建議 (Deep Dive Review)

依照您的要求，這份報告將深入到具體檔案（特別是 `src/media.js`, `src/subtitles.js`, 與 `electron/main.js`）的逐行邏輯，探討更深層的邊界情況（Edge Cases）與未來的架構重構方向。

這裡 **完全不會** 去修改您的程式碼，僅提供專業的洞察與建議。

---

## 1. 媒體與時間軸引擎 (`src/media.js`)

### ⚠️ 潛在邊界情況 (Edge Cases)
* **硬編碼的 10 秒 Timeout** (`media.js:154` 等多處):
  ```javascript
  setTimeout(()=>r(el), 10000); // 等待 onloadedmetadata
  ```
  這裡設定了 10 秒等待音軌載入。若使用者載入的是位於速度極慢的網路磁碟機（NAS）上的超大檔案，可能會提早觸發 Timeout 導致音軌載入失敗。
  👉 **建議**：可以加上一個「取消按鈕」讓使用者自己決定是否中止，或是將 Timeout 拉長至 30 秒，並在等待超過 5 秒時顯示「正在從慢速磁碟讀取中...」的提示。
* **虛擬時間漂移 (Virtual Time Drift)** (`media.js:696`):
  ```javascript
  if(this._vStart!==null) return this._vTime+(performance.now()-this._vStart)/1000*(video.playbackRate||1);
  ```
  在沒有媒體的情況下，您使用了 `performance.now()` 與 `playbackRate` 來模擬時間前進。但如果在播放「途中」改變了 `playbackRate`，歷史累積的時間差將會用「新速率」去乘，導致時間瞬間跳躍（Drift）。
  👉 **建議**：當 `playbackRate` 改變時，應該要先觸發一次虛擬時間的結算（commit `_vTime`），然後重新標記 `_vStart`。
* **靜默吞噬錯誤 (Swallowed Exceptions)** (`media.js:622`):
  ```javascript
  try{ff.FS('unlink',`a${i}.wav`);}catch(e){}
  ```
  您在很多 FFmpeg 清理階段使用了空的 `catch(e){}`。這在前端通常沒問題，但如果虛擬檔案系統 (FS) 真的出了問題導致資源無法釋放，在長達數小時的工作階段中可能會發生 Memory Leak（記憶體洩漏）。
  👉 **建議**：可以加上 `catch(e){ console.debug('FS cleanup:', e) }`，平時不影響介面，但在開發者工具中能留下追蹤線索。

---

## 2. 字幕邏輯與 DOM 操作 (`src/subtitles.js`)

### ⚠️ 潛在邊界情況 (Edge Cases)
* **依賴 RAF 來處理焦點 (Focus Management)** (`subtitles.js:644`):
  ```javascript
  requestAnimationFrame(()=>{
    const nr=sublist.querySelector(`.sub-row[data-id="${newCue.id}"]`);
    // ...
    nt.focus();
  });
  ```
  使用 `requestAnimationFrame` (RAF) 來等待 DOM 渲染完成是個好招，但在 `splitCueAtCursor` 等快速操作中，如果瀏覽器正在處理大量 DOM（例如同時有 3000 行字幕），RAF 有可能在 DOM 真的掛載好之前就觸發，導致 `querySelector` 找不到 `nr` 而直接 `return`（使用者會覺得焦點突然不見了）。
  👉 **建議**：可以使用 `MutationObserver` 或是 `setTimeout(..., 0)` 作為 Fallback，甚至是自製一個 `waitForElement` 的小工具，確保元素出現後才進行 `.focus()`。

* **Sweep 演算法的破壞性** (`subtitles.js:321` `sweepContainedCues`):
  當 `State.overwriteMode` 開啟且 `overwriteKeep` 為 false 時，這支函式負責砍掉/裁切被蓋住的短字幕。目前的寫法相當穩健，但直接對 `State.cues` 進行 `splice` 操作。如果有其他異步操作（像是正在儲存專案的背景程序）剛好也在讀取 `State.cues`，可能會造成資料短暫的不一致。
  👉 **建議**：未來如果專案變得更龐大，盡量讓所有的 State Mutation（狀態修改）保持「不可變（Immutable）」特性。即 `State.cues = State.cues.filter(...)` 而非直接 `splice`。

---

## 3. Node.js 後端進程 (`electron/main.js`)

### ⚠️ 潛在邊界情況 (Edge Cases)
* **殭屍進程 (Zombie Processes)**:
  如果使用者在轉檔（`ffmpeg:ingest` 或 `ffmpeg:streamIngest`）的途中，**強制透過工作管理員關閉 SUB Tool**，或是應用程式崩潰，正在跑的 FFmpeg 子程序 (`child_process.spawn`) 可能不會被作業系統正確回收，變成佔用 CPU 資源的殭屍進程。
  👉 **建議**：可以引入 `node-cleanup` 模組，或者確保在 `app.on('quit')` 及 `process.on('uncaughtException')` 時，遍歷一個記錄所有活躍 PID 的陣列，並呼叫 `kill()`。
* **本地伺服器的 Port 衝突與安全性**:
  在串流 Fragmented MP4 時，您開了一個本地的 Express 伺服器來吐串流。
  - **Port 衝突**：目前是由 OS 分配可用 Port（`listen(0)`），這很安全。
  - **未授權存取**：因為是在 `127.0.0.1` 啟動，代表使用者電腦上的「任何其他背景軟體」甚至「瀏覽器裡跑的其他網頁」理論上都有可能掃到這個 Port 並下載到正在編輯的私密影片。
  👉 **建議**：在啟動伺服器時產生一個隨機的 `token`，並要求 Web 端在存取影片位址時必須帶上 `?token=xxx`，後端 Express 做簡單的驗證，藉此徹底杜絕被同機器的其他程序偷連的問題。

---

## 總結
您的程式碼品質非常高，上述的點都是屬於「防禦性編程 (Defensive Programming)」的極限邊界情況探討。這套系統目前不僅運作良好，更展現了非常深厚的原生 JavaScript 功底！

如果未來有需要針對上述任何一點（例如 **防止 FFmpeg 產生殭屍進程** 或 **為本地伺服器加上 Token 驗證**）進行強化的話，我可以為您提供詳細的實作計畫。
