# SUB Tool — Electron 維護手冊

> 本文件針對本專案實際架構撰寫；每次異動 IPC 通道、ffmpeg 流程、mpv 整合或打包設定時請同步更新。

---

## 1. 系統架構總覽

本專案採用 **Vite + Electron** 架構，三個核心角色：

| 角色 | 檔案 | 職責 |
|------|------|------|
| **Main Process** | `electron/main.js` | 視窗管理、系統 ffmpeg/ffprobe、mpv 嵌入、本機檔案 I/O、快取管理 |
| **Renderer Process** | `dist/index.html`（Vite 打包） | UI 介面、字幕編輯、時間軸（完整前端邏輯） |
| **Preload Script** | `electron/preload.js` | `contextBridge` → `window.subtool`，安全橋接 Node 能力給前端 |

```
Renderer (dist/index.html)
    │  window.subtool.*（contextBridge）
    ▼
Preload (preload.js)
    │  ipcRenderer.invoke(channel, ...)
    ▼
Main (main.js)
    │  ipcMain.handle(channel, ...)
    ├─→ 系統對話框（dialog）
    ├─→ 本機檔案系統（fs）
    ├─→ ffmpeg / ffprobe（child_process.spawn）
    └─→ mpv 子行程（spawn）
```

---

## 2. IPC 通訊機制

### 所有通道一覽（`electron/preload.js` 暴露的介面）

| `window.subtool` 方法 | IPC Channel | 方向 | 說明 |
|---|---|---|---|
| `status()` | `app:status` | R→M | 回傳 `{ffmpeg, venc, mpv}` 狀態 |
| `fileURL(path)` | `fs:fileURL` | R→M | 本地路徑 → 可播放 URL |
| `stat(path)` | `fs:stat` | R→M | 回傳 `{exists, size}` |
| `readB64(path)` | `fs:readB64` | R→M | 讀檔回 base64 字串 |
| `writeProject(path, b64)` | `fs:writeProject` | R→M | 直接寫入指定路徑（自動備份用） |
| `openMedia()` | `dialog:openMedia` | R→M | 系統開檔對話框（影音），回傳路徑 |
| `openAudio()` | `dialog:openAudio` | R→M | 系統開檔對話框（音訊），回傳路徑陣列 |
| `openProject()` | `dialog:openProject` | R→M | 開啟 `.subtool` 專案，回傳 `{b64, path}` |
| `saveProject(name, b64)` | `dialog:saveProject` | R→M | 另存 `.subtool` 專案，回傳儲存路徑 |
| `importSub(kind)` | `dialog:importSub` | R→M | 開啟字幕檔，回傳 `{b64, name}` |
| `exportSub(name, b64, ext)` | `dialog:exportSub` | R→M | 儲存字幕檔，回傳儲存路徑 |
| `probe(path)` | `ffprobe` | R→M | ffprobe 探測，回傳 `{duration, fps, video, audio[]}` |
| `makeProxy(path, dur)` | `ffmpeg:proxy` | R→M | 轉製 720p proxy（非即時，阻塞） |
| `extractAudio(path, idx, dur, codec)` | `ffmpeg:extractAudio` | R→M | 抽取單一聲道 |
| `waveAudio(path, dur)` | `ffmpeg:waveAudio` | R→M | 抽取 8kHz mono WAV（波形用） |
| `cleanupAudio(path)` | `ffmpeg:cleanup` | R→M | 刪除暫存音訊檔 |
| `ingest(opts)` | `ffmpeg:ingest` | R→M | 單次多輸出：proxy + 所有聲道 + 波形 |
| `streamIngest(opts)` | `ffmpeg:streamIngest` | R→M | 邊轉邊播：先回傳快取或邊轉的 URL，背景繼續 |
| `cacheInfo()` | `cache:info` | R→M | 回傳快取統計 `{root, folders, bytes}` |
| `cacheCleanOrphans()` | `cache:cleanOrphans` | R→M | 刪除無效快取資料夾 |
| `cacheClearAll(src)` | `cache:clearAll` | R→M | 清除全部快取 |
| `onProgress(cb)` | `task-progress` | M→R | ffmpeg 進度推播 `{jobId, label, pct, done}` |
| `mpv.detect()` | `mpv:detect` | R→M | 檢查 mpv 是否可用 |
| `mpv.launch(opts)` | `mpv:launch` | R→M | 啟動 mpv 嵌入播放（`{src, bounds, audio}`） |
| `mpv.seek(t)` | `mpv:seek` | R→M | 跳轉播放位置 |
| `mpv.play()` / `mpv.pause()` | `mpv:play` / `mpv:pause` | R→M | 播放 / 暫停 |
| `mpv.mute(v)` | `mpv:mute` | R→M | 靜音切換 |
| `mpv.rate(r)` | `mpv:rate` | R→M | 播放速率 |
| `mpv.setBounds(b)` | `mpv:setBounds` | R→M | 更新 mpv 覆蓋視窗位置與大小 |
| `mpv.show(v)` | `mpv:show` | R→M | 顯示 / 隱藏 mpv 視窗 |
| `mpv.subSet(ass)` | `mpv:subSet` | R→M | 餵入 ASS 字幕（防抖 100ms） |
| `mpv.quit()` | `mpv:quit` | R→M | 關閉 mpv |
| `mpv.onEvent(cb)` | `mpv:event` | M→R | mpv 事件推播（`time-pos`, `duration`, `pause`, `eof` 等） |

> **新增 IPC 通道時**：① `preload.js` 加 `ipcRenderer.invoke`；② `main.js` 加 `ipcMain.handle`；③ 更新此表。

---

## 3. 開發環境

### 前置需求

- Node.js 18+（`npm install` 安裝 Vite / Electron 相依）
- ffmpeg / ffprobe（MXF / 多音軌功能）：放入 PATH 或 `C:\Program Files\FFMPEG\bin\`
- mpv（秒開功能，選用）：系統安裝後放入 PATH

### 開發流程

```bash
# 方式一：開發模式（熱更新 + DevTools）
npm run dev               # 終端機 1：Vite dev server → http://localhost:8777
npm run electron:dev      # 終端機 2：Electron 載入 localhost:8777

# 方式二：build 後啟動（接近正式使用者體驗）
npm run electron          # build → dist/index.html → Electron
```

`--dev` 旗標由 `process.argv.includes('--dev')` 偵測，`electron:dev` 自動帶入。

### 安全性設定（`main.js` createWindow）

```js
webPreferences: {
  preload: 'electron/preload.js',
  contextIsolation: true,   // preload 與 renderer 完全隔離
  nodeIntegration: false,   // renderer 不可直接用 Node API
  webSecurity: false        // 允許 file:// 本地媒體讀取（本機信任程式）
}
```

> `webSecurity: false` 僅在桌面版使用；網頁版維持瀏覽器預設值（安全）。

---

## 4. ffmpeg / ffprobe 整合

### 路徑偵測順序（`detect()` 函式）

1. 內建（`electron/ffmpeg/ffmpeg.exe` 及 asar.unpacked 路徑）
2. 環境變數 `FFMPEG_PATH` / `FFPROBE_PATH`
3. 系統 PATH 中的 `ffmpeg` / `ffprobe`
4. `C:\Program Files\FFMPEG\bin\`
5. `C:\ffmpeg\bin\`

### 硬體視訊編碼器偵測

啟動時依序測試 `h264_nvenc` → `h264_qsv` → `h264_amf`，全失敗則用 `libx264`。結果存入 `VENC`。
可在 DevTools console 執行 `await window.subtool.status()` 查看 `venc` 欄位。

### 轉檔輸出規格

- **Proxy 影片**：720p、yuv420p、CRF 26（NVENC: cq 26、QSV: global_quality 26）
- **聲道音訊**：AAC 192kbps `.m4a`
- **波形用音訊**：8kHz mono 16-bit PCM WAV

### 媒體快取

快取鍵 = `SHA-1(basename + size + 前 1MB 內容)`（不含修改時間，跨電腦可用）

候選目錄（依序讀取第一個有效的、寫入第一個可寫的）：
1. 影片所在目錄旁的 `.subtool_Cache/<key>/`
2. `%APPDATA%\sub-tool\mediacache\<key>/`（`CACHE` = `app.getPath('userData')`）

暫存路徑：`%TEMP%\subtool_cache\`（程式退出時清除）。

---

## 5. mpv 嵌入整合

mpv 以**子視窗**方式嵌入：Main Process 啟動 `_mpvWin`（無框 BrowserWindow）並蓋在播放區域上方。

### 主要行為

- `mpv:launch`：啟動 mpv IPC socket（`\\.\pipe\mpvsocket_<pid>`），建立連線後送播放指令
- `mpv:event` 推播：`time-pos`、`duration`、`pause`、`eof-reached`（前端用於同步播放頭）
- `mpv:subSet`：接收 base64 ASS 字串，寫入暫存 `.ass` 後用 `sub-reload` 指令更新
- `mpv:setBounds`：更新 `_mpvWin` 位置；主視窗移動/縮放時自動呼叫

### 注意事項

- `_mpvWin` 與 `mainWin` 是不同的 BrowserWindow；`mainWin.minimize()` 時需手動 `_mpvWin.hide()`
- `safeSend(wc, ch, data)`：視窗關閉後 IPC 回呼可能仍在執行，必須先確認 `!wc.isDestroyed()`
- mpv 版本需支援 `--input-ipc-server`；偵測失敗時 fallback 到 ffmpeg 單次轉檔

---

## 6. 打包與發布

```bash
npm run dist    # vite build + electron-builder
```

**輸出**：`release/` 下的 **win zip**（解壓即可執行）。

**`package.json` electron-builder 設定**：
```json
{
  "win": { "target": "zip" },
  "files": ["dist/**/*", "electron/**/*"],
  "asarUnpack": ["electron/mpv/**", "electron/ffmpeg/**"]
}
```

> `asarUnpack` 確保 mpv.exe / ffmpeg.exe 不被 asar 打包，可被 `child_process.spawn` 直接呼叫。

---

## 7. 常見問題排查

| 症狀 | 檢查項目 |
|------|----------|
| 主視窗無法啟動 | 確認 `npm install` 完成；檢查 `electron/main.js` Node 相依 |
| 前端無法呼叫 `window.subtool` | `preload.js` 是否正確載入；`contextBridge.exposeInMainWorld` 是否成功 |
| ffmpeg 功能無效 | `await window.subtool.status()` → 查看 `ffmpeg` 欄位；確認 ffmpeg 在 PATH |
| 影片黑畫面（4:2:2）| ffmpeg 未加 `-vf format=yuv420p`；proxy 輸出格式不相容 |
| mpv 無法啟動 | 確認系統已安裝 mpv 且在 PATH；socket 路徑 `\\.\pipe\mpvsocket_<pid>` 是否有衝突 |
| GPU 編碼器不可用 | 確認驅動版本；`status()` 回傳 `venc: "libx264"` 表示已 fallback |
| 快取未命中（每次都重新轉） | 來源檔前 1MB 或大小有變動；可手動刪除 `.subtool_Cache` 強制重建 |
| `task-progress` 無回報 | `sender` 是否傳入 `runFF`；`safeSend` 是否因視窗已銷毀而跳過 |

---

## 8. 變更紀錄

各版本詳細變更請見 [`CHANGELOG.md`](CHANGELOG.md)。

每次修改 IPC 通道或架構後，請同步更新本文件第 2 節通道列表。
