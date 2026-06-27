# SUB Tool 專案審查報告

我已經徹底檢視了 `SUB_Tool` 的原始碼架構、前後端（Electron 與 Vanilla JS）邏輯、效能最佳化實作，以及安全性設計。

整體來說，這是一個**架構非常扎實且效能極佳**的專案。開發者（您）在不用任何大型框架（如 React / Vue）的限制下，把原生 JavaScript 發揮到了極致，尤其是針對大量 DOM 節點的渲染優化以及影音轉檔的資源調度都處理得非常漂亮。

以下是我歸納的詳細審查結果與未來可以強化的潛在問題點：

## 🌟 架構亮點與優良設計

### 1. 卓越的效能優化 (Performance)
* **批次 DOM 更新與事件代理**：在 `subtitles.js` 中，透過 `_subRowHTML` 先組合字串再一次性 `innerHTML` 更新（取代逐個建立節點），讓 1500 行字幕的渲染時間降至極低；並且充分使用了 `Event Delegation`（將事件綁定在 `sublist` 容器上）。
* **渲染防抖 (Debounce / RAF)**：在打字輸入時使用 `_debouncedHeavyEdit` 延遲觸發時間軸重繪；在拖曳時間軸時使用 `requestAnimationFrame`（`_handleDragUpdate`），以及直接操作快取的 Element 節點 (`drag.grp[0].el`) 而不是每幀查詢 DOM，確保了 60fps 順暢拖曳。
* **演算法提速**：`_detectOverlaps` 利用字幕已排序 (`sorted`) 的特性，在迴圈中設定提早 `break` 條件，巧妙避開了 $O(N^2)$ 的效能陷阱。

### 2. 聰明的影音後端架構 (Electron / FFmpeg / mpv)
* **mpv 無縫嵌入**：利用 Electron `BrowserWindow` 的無邊框、透明特性疊加，再透過 `--wid` 參數將原生 mpv 播放器視窗渲染進去。完美解決了 Web 原生不支援 MXF 或特定編碼的痛點，不需要即時轉碼整個畫面。
* **Fragmented MP4 邊轉邊播**：在 `ffmpeg:streamIngest` 中使用了 `empty_moov` 與本地 HTTP Server (`127.0.0.1`) 串流，讓使用者不需要等待整部影片轉檔完畢就能直接開始看。
* **硬體加速自動偵測**：自動偵測 NVENC / QSV / AMF 進行轉碼，大幅減少 CPU 負載。

### 3. 安全性防護 (Security)
* **IPC 路徑白名單**：Electron `main.js` 實作了 `_allowedDirs` 機制，嚴格限制 Renderer 進程只能讀寫專案目錄或快取目錄，防範任意路徑寫入（Path Traversal）漏洞。
* **Content-Security-Policy (CSP)**：在 `vite.config.mjs` 打包階段自動注入嚴格的 CSP 標籤。
* **XSS 防護**：自製的 `escapeHTML` 工具函式被確實運用在每一處使用者輸入（文字、檔名），避免惡意程式碼注入。

---

## 🔍 潛在問題與未來改善建議

雖然程式已經非常穩健，但隨著功能擴充，有幾個地方可以考慮進行重構或改善：

### 1. 巨大檔案 (Monolithic Files) 的維護性
* **問題**：`electron/main.js` (848 行)、`src/timeline.js` (785 行) 與 `src/subtitles.js` (834 行) 的程式碼較長，內部邏輯（如介面操作、繪製、核心計算）有些交織。
* **建議**：
  * 可將 mpv 相關的 IPC 與生命週期管理獨立拆分到 `electron/mpv.js`。
  * `timeline.js` 可拆分為 `timeline-render.js`（專注 Canvas 畫圖）與 `timeline-interact.js`（專注滑鼠拖曳與縮放）。

### 2. 全域狀態管理 (State Management)
* **問題**：目前的 `State` 是一個單純的 Object，每次修改後必須手動呼叫 `emit('render:all')` 或是特定的 render 函式。如果未來有新成員加入開發，很容易忘記呼叫而導致畫面與資料不同步（Desync）。
* **建議**：不一定要引進大框架，但可以考慮使用原生的 JavaScript `Proxy` 將 `State` 包裝起來，當特定屬性（如 `cues`）變動時「自動」觸發事件，減少心智負擔。

### 3. Node.js 版本鎖定
* **問題**：這次發生的 CI 錯誤就是因為本機環境（Node 24）與 GitHub Actions 預設環境（Node 20）產生了 `package-lock.json` 版本不匹配的問題。
* **建議**：可以在 `package.json` 中加入 `engines` 欄位宣告支援版本，或是在專案根目錄新增 `.nvmrc` 檔案，讓團隊成員或雲端環境能自動切換到統一的版本。

### 4. 缺乏端對端 (E2E) 測試
* **問題**：目前有很好的 Unit Tests（利用 Vitest 測試 `formats`, `time`, `util` 等純邏輯模組），但針對「拖曳時間軸」、「點擊新增軌道」等與 DOM 強烈耦合的操作缺乏自動化測試。
* **建議**：可考慮引入 **Playwright** 等端對端測試工具，撰寫幾個關鍵的自動化腳本（如開啟專案 -> 拖曳字幕 -> 驗證 DOM 位置），能大幅降低未來重構時踩雷的風險。

---

### 💡 總結
這是一個完成度極高的高品質工具！目前的架構完全能夠撐起現有的業務需求，且效能表現會比市面上許多用 Electron 包裝的笨重網頁應用來得好很多。上述建議主要是針對「未來擴展」與「維護性」的防患未然。如果有哪一項建議您覺得想現在就開始著手（例如**加入 Proxy 狀態管理**或是**切割主程式**），我隨時可以為您進行實作！
