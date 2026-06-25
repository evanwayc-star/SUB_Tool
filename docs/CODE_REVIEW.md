# SUB Tool — Code Review 指引

本文記錄 Code Review 的標準清單與過去重要修復案例，供維護者在審查 PR 或重構時參考。

---

## Review 標準清單

### 架構守則

- [ ] 沒有新增 `import … from './app.js'`（所有跨模組協調透過 `emit`/`on` 事件匯流排）
- [ ] 新事件已在 `app.js` 訂閱區補上對應 `on(...)` 行，並更新 `#開發說明.md` 事件列表
- [ ] 新增 IPC 通道時三件事同步完成：`preload.js` + `main.js` + `ELECTRON_MAINTENANCE.md` 通道列表
- [ ] 葉模組（`time.js`、`util.js`、`tcparse.js`、`formats.js`）無 `import` app.js / ui.js 等高層模組

### FPS / 時碼一致性（見 `FPS_時碼一致性.md`）

- [ ] 時碼顯示使用 `secToEncore(秒, State.fps, State.dropFrame)`，不自行拼字串
- [ ] 取播放位置用 `Media.displayTime()`，不直接讀 `video.currentTime` / mpv `e.data`
- [ ] 對齊影格用 `snapTimeToFrame(秒, State.fps, State.dropFrame)`
- [ ] 逐格步進以 `displayTime()` 為基準，不用 `vTime()`
- [ ] 新時碼相關程式碼已標 `FPS-SYNC` 標記，並更新 `FPS_時碼一致性.md` 第 3 節對照表

### 記憶體與資源

- [ ] Audio / Video 元素 `src = ''` 後才 `null`（讓瀏覽器釋放媒體資源）
- [ ] `AudioBufferSourceNode.stop()` 後有 `disconnect()`
- [ ] ffmpeg.wasm 虛擬 FS 操作用 `try/finally` 確保清理
- [ ] 非同步流程有競爭條件保護（快照 idx，await 後檢查是否已過期）

### Electron IPC

- [ ] IPC 回呼中使用 `safeSend(wc, ch, data)` 而非直接 `.send()`（視窗可能已銷毀）
- [ ] `ipcMain.handle` 的 handler 有適當 `try/catch`，不讓 Main Process 崩潰

### UI 行為

- [ ] 破壞性確認（刪除軌道、清除全部備忘）使用 `openModal`，不用原生 `confirm()`
- [ ] DOM focus 時序用 `requestAnimationFrame`，不用 `setTimeout(30ms)`
- [ ] 對話框在 mpv 模式下有處理 mpv 視窗顯示 / 隱藏

### 資料完整性

- [ ] `sortCues` 排序鍵含 `id` 次排序，確保穩定排序
- [ ] 版本號判斷用明確比較（`=== undefined || === null`），不用 `|| 1`（避免 falsy 誤判）
- [ ] `History.record` 有快速結構比對，避免大量字幕時的全量 JSON 序列化

---

## 驗證方法

```bash
npx eslint src              # 抓未匯入的名稱
npm run build               # rollup 抓匯出端問題
grep -rn "from './app.js'" src   # 應為空（無循環相依）
```

---

## 過去重要修復（v2.8.0，2026-06-24）

v2.8.0 共修復 19 項程式碼審查問題與 3 個 FPS/時碼一致性 Bug，詳細說明見 [`CHANGELOG.md`](CHANGELOG.md)。

修復類別摘要：

| 類別 | 項目數 |
|------|--------|
| 記憶體洩漏（Audio/Video/ffmpeg FS/AudioGraph） | 4 |
| 競爭條件（Wave.selectSource、splitToChannelTracks ID 碰撞） | 2 |
| 效能（History 序列化、drawTimeline 拆分輕量版） | 2 |
| 資料完整性（排序、版本判斷、DOM 解耦） | 3 |
| UI 行為（confirm → openModal、setTimeout → rAF） | 4 |
| Electron 相關（mpv bounds 頻率、大檔提示文字、CDN fallback） | 3 |
| FPS / 時碼一致性 Bug A/B/C | 3 |

---

## 本地 build 基準（v2.8.0）

```
vite v5.4.21 building for production...
✓ 25 modules transformed.
dist/index.html  204.62 kB │ gzip: 73.88 kB
✓ built in 242ms
0 錯誤、0 警告
```

後續修改應維持 `npm run build` 0 錯誤、0 警告。
