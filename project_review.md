# SUB Tool 專案與程式碼審查報告

> 審查工具：`code-review-skill` (Universal Quality Guide, Architecture Review Guide, Performance Review Guide)
> 審查日期：2026-06-29

本報告針對 SUB Tool 的架構設計、效能表現、狀態管理與程式碼品質進行深度審查，並提出後續可改善的方向。

---

## 1. 架構審查 (Architecture & Design)

### 🟢 [praise] 優秀的單向依賴與模組解耦
專案採用原生的 ES Modules，並引入了 `events.js` 作為統一的事件匯流排 (Event Bus)。這項設計非常成功地解決了循環依賴 (Circular Dependency) 的問題：
- 底層模組（如 `subtitles.js`, `timeline.js`）只需 `emit('render:all')`，不需反向 `import app.js`。
- `app.js` 專職擔任協調層 (Coordinator)，集中處理事件訂閱與渲染分派。
- **評價**：高度符合 Single Responsibility Principle，在沒有框架支援下，維持了極佳的程式碼整潔度。

### 🟡 [important] 狀態可變性 (State Mutability) 的潛在風險
目前 `state.js` 中的 `State` 物件是全域可變 (Global Mutable) 的。
- 任何模組都可以直接修改 `State.cues` 或 `State.fps`。
- `history.js` 採用 `structuredClone` 進行全量快照，雖然實作簡單可靠，但在字幕數量極大 (如 2000+ 句) 時，每次按鍵或移動的 `recordHistory` 會造成明顯的記憶體與 CPU 開銷。
- **建議**：雖然目前專案規模尚可接受，但未來可考慮引入 Immutable 資料結構概念，或針對 `cues` 實作局部差異備份 (Diff-based Undo/Redo)，取代深拷貝。

---

## 2. 效能審查 (Performance)

### 🟢 [praise] 拖曳互動的效能優化 (DOM 更新策略)
在 `timeline.js` 中處理字幕區塊拖曳時，實作了非常好的效能優化：
- `mousemove` 時僅更新 `.cue-block` 的 inline-style (`style.left`/`style.width`)，並沒有觸發耗時的 `renderAll()`。
- 直到 `mouseup` 才執行全量重繪與排序。
- **評價**：這是避免 Layout Thrashing 與大量 Reflow 的標準最佳實踐。

### 🟡 [important] 頻繁的全量渲染 (Render All)
目前很多操作（例如新增字幕、刪除字幕）都會觸發 `renderAll()`，這會重建整個字幕列表 DOM 以及時間軸。
- 在萬句字幕的情況下，`innerHTML` 重建 `sublist` 可能會造成 UI 卡頓。
- **建議 (Eventual)**：針對 `subtitles.js` 的列表渲染，可以實作「虛擬列表 (Virtual Scrolling/Windowing)」，只渲染目前捲動視窗內可見的字幕列，大幅降低 DOM 節點數量。

### 🟡 [important] Web Audio 資源釋放 (Memory Leaks)
在 `mixer.js` 與 `media.js` 切換音軌時，雖然有建立 `GainNode` 和 `AnalyserNode`，但需要特別注意切換影片或重置專案時，是否有確實呼叫 `disconnect()` 與關閉舊的 `AudioContext`。
- **建議**：在 `resetProject()` 流程中加入明確的 Audio Node 清理機制，防止長駐運作下的記憶體洩漏。

---

## 3. 程式碼品質與安全性 (Code Quality & Security)

### 🟢 [praise] 跨平台防呆機制
程式碼中充滿了對瀏覽器與 Electron 雙模式的良好判斷（透過 `IS_DESKTOP` 與 `DESK`），並在 Web 模式下限制了 ffmpeg 的處理大小，桌面模式下則自動切換為系統 ffmpeg 與 mpv 播放器，這項策略非常務實且安全。

### 💡 [suggestion] 魔法字串 (Magic Strings)
在 `events.js` 和各處呼叫 `emit()` 時，使用了大量的字串（例如 `'render:all'`, `'duration:known'`）。
- **建議**：可以考慮在 `events.js` 內宣告一個常數物件 `export const EVENTS = { RENDER_ALL: 'render:all', ... }`，以減少打字錯誤導致的 bug。

### 💡 [suggestion] 防範 XSS 攻擊
在 `renderVideoSub` 中已經有使用 `escapeHTML`，這非常重要。不過在 `subtitles.js` 渲染列表時，建議也全面檢查是否所有使用者輸入的字幕文字 (`c.text`) 都已經經過跳脫再寫入 `innerHTML`。

---

## 4. 總結與決策 (Summary)

**結論**：專案架構清晰、模組化程度高， Vanilla JS 的實作展現了扎實的基礎功底。特別是在時間軸與影片時碼同步的處理上（29.97 Drop-frame）非常嚴謹。
目前程式碼品質處於健康狀態（**Approved ✅**），無需進行破壞性的緊急重構。

**後續文件更新計畫**：
由於程式碼邏輯與現有架構設計高度吻合，接下來我將對 `README.md` 及 `docs/` 下的所有文件進行優化與對齊，確保文件能 100% 反映這些優秀的設計。
