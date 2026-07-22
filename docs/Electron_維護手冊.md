# SUB Tool — Electron 維護手冊

> 對應版本：v4.6.1｜最後更新：2026-07-22

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
| `getFilePath(file)` | —（preload 內直接呼叫 `webUtils.getPathForFile`，無 IPC） | R | 拖放的 `File` 物件 → 絕對路徑。Electron 32 起 `File.path` 已移除；只接受真正的 File 物件、失敗回 `null`。供拖放影音走桌面載入路徑（`loadDesktopMedia`） |
| `readB64(path)` | `fs:readB64` | R→M | 讀檔回 base64 字串 |
| `writeProject(path, b64)` | `fs:writeProject` | R→M | 直接寫入指定路徑（自動備份用） |
| `openMedia()` | `dialog:openMedia` | R→M | 系統開檔對話框（影音），回傳路徑 |
| `openAudio()` | `dialog:openAudio` | R→M | 系統開檔對話框（音訊），回傳路徑陣列 |
| `openProject()` | `dialog:openProject` | R→M | 開啟 `.subtool` 專案，回傳 `{b64, path}` |
| `saveProject(name, b64)` | `dialog:saveProject` | R→M | 另存 `.subtool` 專案，回傳儲存路徑 |
| `importSub(kind)` | `dialog:importSub` | R→M | 開啟字幕檔，回傳 `{b64, name}` |
| `exportSub(name, b64, ext)` | `dialog:exportSub` | R→M | 儲存字幕檔，回傳儲存路徑 |
| `exportVideo(opts)` | `ffmpeg:exportVideo` | R→M | 匯出影片序列：`{clips[],videoTracks[],width,height,fps,assText,format:'prores'\|'mp4'\|'wav',duration,audioPlan,timecodeWatermark?}`。同一 filtergraph 疊合片段與靜態圖片（`type:'image'` 會以 `-loop 1` 供應全段）、燒字幕，選用時再疊交付用時間碼；影片輸出為 ProRes422HQ/H.264，WAV 則為多聲道 PCM。 |
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
| `mpv.seek(t)` | `mpv:seek` | R→M | 跳轉播放位置（**來源時間**；影片序列的時間軸↔來源映射在前端 media.js 處理） |
| `mpv.loadfile(p)` | `mpv:loadfile` | R→M | 影片序列跨段切換：同一 mpv 實例換檔（保留 --wid 嵌入與屬性），輪詢 duration 就緒後回傳 `{duration}`；路徑受 S1 白名單管制 |
| `mpv.play()` / `mpv.pause()` | `mpv:play` / `mpv:pause` | R→M | 播放 / 暫停 |
| `mpv.mute(v)` | `mpv:mute` | R→M | 靜音切換 |
| `mpv.rate(r)` | `mpv:rate` | R→M | 播放速率 |
| `mpv.setBounds(b)` | `mpv:setBounds` | R→M | 更新 mpv 覆蓋視窗位置與大小 |
| `mpv.setGuide(g)` | `mpv:setGuide` | R→M | 更新一般安全框／字幕操作 guide |
| `mpv.setImageGuide(data)` | `mpv:setImageGuide` | R→M | 將圖片疊層 HTML、播放器矩形與命中區交給透明 guide 視窗；只有圖片及其控制點能取得 pointer 輸入 |
| `mpv.onImagePointer(cb)` | `mpv:imagePointer` | M→R | guide 回送白名單化的 `start/move/end/cancel` 拖曳座標；renderer 依同一套幾何規則修改圖片位置與大小 |
| `mpv.setTimecodeWatermark(data)` / `clearTimecodeWatermark()` | `mpv:setTimecodeWatermark` / `mpv:clearTimecodeWatermark` | R→M | 在原生 mpv 畫面上顯示／清除僅監看的時間碼，資料為 `{text,rect}`；不經 ASS、不會燒進輸出 |
| `mpv.show(v)` | `mpv:show` | R→M | 顯示 / 隱藏 mpv 視窗。mpv 為 OS 層子視窗、HTML z-index 蓋不過：前端 `_syncMpvPanel()`（app.js）在對話框（含快捷鍵設定）、重疊影片的浮動面板／搜尋視窗／右鍵選單開啟時自動呼叫此方法讓位，關閉後恢復（`mpv:sync` 事件） |
| `mpv.subSet(ass)` | `mpv:subSet` | R→M | 餵入 ASS 字幕（防抖 100ms） |
| `mpv.quit()` | `mpv:quit` | R→M | 關閉 mpv |
| `mpv.onEvent(cb)` | `mpv:event` | M→R | mpv 事件推播（`time-pos`, `duration`, `pause`, `eof` 等） |

### 設定 / 字型 / 應用生命週期（v4.23 以後陸續加入）

| `window.subtool` 方法 | IPC Channel | 方向 | 說明 |
|---|---|---|---|
| `isDesktop` | —（preload 內的常數 `true`） | — | 前端 `state.js` 用它判定桌面版（`DESK`）；網頁版沒有 `window.subtool`，取值為 undefined |
| `fontsList()` | `fonts:list` | R→M | 掃 `font/` 下每個子資料夾，回傳 `{fonts:[{name, file, family}]}`。`name`＝資料夾名（UI 顯示）、`family`＝**字型檔內部家族名**（ASS 要用這個，見鐵律 §0.3）。此 handler 內會把字型路徑加進白名單，renderer 才取得到 `fs:fileURL` |
| `configLoad()` | `config:load` | R→M | 讀 `%APPDATA%/sub-tool/config.json`（設定、常用樣式 `subPresets` 等） |
| `configSave(data)` | `config:save` | R→M | **淺層合併**寫回 config.json（只傳要改的鍵即可） |
| `keysLoad()` | `keys:load` | R→M | 讀自訂快捷鍵對應表 |
| `keysSave(data)` | `keys:save` | R→M | 寫自訂快捷鍵對應表（快捷鍵設定視窗另有匯出／匯入 JSON 檔） |
| `exportDirectory(files)` | `dialog:exportDirectory` | R→M | 選一個資料夾後批次寫入多個檔案（分軌匯出字幕用） |
| `getStartupFile()` | `app:getStartupFile` | R→M | 取「雙擊 `.subtool` 啟動」時帶進來的檔案路徑（前端啟動後主動問一次） |
| `onOpenFile(cb)` | `app:open-file` | M→R | 程式已在執行時又雙擊 `.subtool` → 推播路徑 |
| `onAppRequestClose(cb)` | `app:request-close` | M→R | 使用者按視窗關閉鈕 → 主行程**先攔下來**問前端（前端跳「未儲存」確認） |
| `closeApp()` | `app:close` | R→M | 前端確認完畢，真的關閉 |

> **新增 IPC 通道時**：① `preload.js` 加 `ipcRenderer.invoke`；② `main.js` 加 `ipcMain.handle`；③ 更新此表。
>
> **路徑安全**：主行程對所有檔案操作走白名單（`allowDir()` / `allowFile()`）。新增任何會讀寫
> 使用者路徑的通道時，記得把該路徑加進白名單，否則 renderer 拿不到 `fs:fileURL`——這正是
> 字型管線當初漏掉的一步。

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
- `mpv:setImageGuide`：透明 guide 視窗顯示圖片、虛線框與控制點。主程序依游標是否落在圖片命中區切換 `setIgnoreMouseEvents`，拖曳期間保留 pointer capture；圖片外的滑鼠事件會穿透回主 renderer，不能以全視窗 `forward:true` 取代。
- `mpv:setTimecodeWatermark`：原生 mpv 模式由 guide 顯示監看 TC；一般 HTML 預覽仍由 renderer DOM 顯示。兩者都從 `Media.displayTime()` 取得同一個時碼來源。

### 注意事項

- `_mpvWin` 與 `mainWin` 是不同的 BrowserWindow；`mainWin.minimize()` 時需手動 `_mpvWin.hide()`
- `safeSend(wc, ch, data)`：視窗關閉後 IPC 回呼可能仍在執行，必須先確認 `!wc.isDestroyed()`
- mpv 版本需支援 `--input-ipc-server`；偵測失敗時 fallback 到 ffmpeg 單次轉檔

---

## 6. 打包與發布

```bash
npm run dist    # vite build + electron-builder
```

**輸出**：`release/SUB Tool Setup <版本>.exe`（NSIS 安裝檔，約 287 MB——絕大部分是內建的
ffmpeg／mpv 與字型）。安裝後會關聯 `.subtool` 副檔名，雙擊專案檔即可開啟。

**正式發布**：先執行 lint、test、build 與桌面媒體驗證；確認 `release/` 的 Setup 檔名包含正確版號後，將原始碼推送到 `main`，再以同一個 commit 建立 GitHub tag／Release 並上傳同一支 Setup `.exe`。發布說明應連結 `docs/版本變更紀錄.md` 對應段落，不能只推送 commit 而漏掉安裝檔。

**`package.json` electron-builder 設定**（實際值）：
```json
{
  "win":  { "target": "nsis" },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true,
            "createDesktopShortcut": true, "createStartMenuShortcut": true },
  "fileAssociations": [{ "ext": "subtool", "role": "Editor" }],
  "directories": { "output": "release" },
  "files":         ["dist/**/*", "electron/**/*"],
  "extraResources":[{ "from": "font", "to": "font", "filter": ["**/*"] }],
  "asarUnpack":    ["electron/mpv/**", "electron/ffmpeg/**"]
}
```

- `asarUnpack` 確保 mpv.exe / ffmpeg.exe 不被 asar 打包，可被 `child_process.spawn` 直接呼叫。
- **`extraResources` 是字型能不能用的關鍵**：`files` 只收 `dist/` 與 `electron/`，`font/`
  必須另外用 `extraResources` 送進 `resources/font`。v4.26 少了這一段 → **開發時字型正常、
  裝起來的 exe 一個字型都沒有**（v4.27.0 修）。`fontsRoot()` 依 dev（專案根）→
  `resources/font` → 安裝目錄 順序尋找。
- 換 ffmpeg build 前先讀 §7 與變更紀錄：**BtbN 的 gpl-shared 版會截斷多串流 MXF 的音訊**，
  目前固定用 gyan 的 full_build。任何抽換都必須拿真實的多音軌 MXF 驗過。

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
| **完全無法匯出影片**（filterchain 解析失敗） | `fontsdir=` 的 Windows 磁碟機冒號要跳脫**兩層**（`C\\:/`）。單反斜線會讓 ffmpeg 把 `:` 當選項分隔符。注意手動在 shell 跑也會撞到同一個錯，很容易誤判成「shell 吃掉跳脫字元」——用 `spawn`（無 shell 介入）重測才能確認 |
| 匯出的字幕**字型不對**（變成微軟正黑體） | ASS 的 Fontname 必須是**字型檔內部家族名**（`fontsList()` 回的 `family`），不是資料夾名。libass 配不到會**靜默**退回，沒有錯誤訊息——查 libass 的 `fontselect:` 輸出，退回旗標 1 ＝ 沒配到 |
| 安裝版沒有任何字型可選 | `package.json` 少了 `extraResources`（見 §6） |
| 使用者說某個按鈕「按了沒反應」 | 是不是用到了 `window.prompt()`？**Electron 停用了它**，回傳永遠是 null，靜默失敗。改用 `ui.js` 的 `promptModal()` |
| HTML 疊層（字幕拖曳、安全框）在 MXF 模式下看不到 / 點不到 | mpv 是 **OS 層 always-on-top 子視窗**，蓋在所有 HTML 之上；需要 `mpv.show(false)` 讓位（`_syncMpvPanel()`） |
| 圖片在 mpv 預覽看得到框但不能拖曳，或拖曳時字幕／安全框消失 | 檢查 `mpv-guide-preload.js`、`mpv:setImageGuide`、`mpv:imagePointer` 三段是否都存在；guide 必須只在圖片命中區接收輸入，拖曳結束後重新穿透。 |
| 圖片匯出只顯示第一格或後段變黑 | 檢查 renderer 是否保留 `clip.type === 'image'`；主程序必須對該輸入加 `-loop 1 -framerate <project fps>`，並把每個 clip 的 `scale/posX/posY` 傳進 filtergraph。 |
| TC 監看在 mpv 模式不顯示 | 先確認播放器 TC 開關為開，再檢查透明 guide 是否建立；這是監看 overlay，與匯出視窗的「壓入時間碼浮水印」為兩個獨立開關。 |
| 解除影音顯示無法建立獨立音訊 | 不要以 Chromium `<audio>` 直接讀 MXF／部分 MOV 容器；確認 `ffmpeg:ingest` 有產出逐聲道 `.m4a` 快取，並確認還原資料保留 `preferCache:true` |

---

## 8. 變更紀錄

各版本詳細變更請見 [`版本變更紀錄.md`](版本變更紀錄.md)。

每次修改 IPC 通道或架構後，請同步更新本文件第 2 節通道列表。
