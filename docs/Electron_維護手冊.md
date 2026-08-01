# SUB Tool — Electron 維護手冊

> 本文件針對本專案實際架構撰寫；每次異動 IPC 通道、ffmpeg 流程、mpv 整合或打包設定時請同步更新。

---

## 1. 系統架構總覽

本專案採用 **Vite + Electron** 架構，核心角色與後端支援模組如下：

| 角色 | 檔案 | 職責 |
|------|------|------|
| **Main Process** | `electron/main.js` | 視窗管理、平台原生 ffmpeg/ffprobe、Windows mpv 嵌入、本機檔案 I/O、快取管理 |
| **匯出計畫（純邏輯）** | `electron/export-plan.js` | 音訊路由、filtergraph 片段、AAC bitrate、時間碼浮水印濾鏡。**零 `require`** ——保持純函式才能在 vitest 直接測（見 `tests/exportPlan.test.js`）。需要副作用的部分（找字型、探測音軌、硬體編碼器）一律由 `main.js` 傳入 |
| **檔案能力權威** | `electron/file-authority.js` | 精確 read/write、專案 autosave、交付輸出、截圖、佇列 log 與內部 cache 的分離 capability；renderer 的字串路徑不會自動升權 |
| **匯出工作狀態機** | `electron/export-job-status.js` | **七種狀態與四個分類的唯一定義**（見下方「匯出工作的狀態機」）。零 `require`，純資料＋述詞 |
| **匯出佇列儲存** | `electron/queue-store.js` | 工作 JSON／ASS／log 的原子寫入、讀取、排序與來源檔蒐集 |
| **完成紀錄** | `electron/queue-history.js` | 已完成交付的稽核紀錄（跨重啟保留、上限 200 筆）。**刻意不走 queue-store**：只存渲染完成卡片需要的欄位，**不含 `payload` 的 `clips`／`audioPlan`**，因此不可能被重新排程執行 |
| **匯出佇列狀態** | `electron/export-queue-state.js` | 唯一有序工作集合；scheduler、監控畫面、重試與持久化都讀同一份順序。`liveWorkCount()`（running＋stopping）是「還在轉檔嗎」的唯一定義，兩個關閉決策都讀它 |
| **匯出輸出鎖** | `electron/export-lease.js` | 依正規化輸出路徑建立原子 lease，避免不同工作同時以 `-y` 寫入同一檔案 |
| **匯出監護程序** | `electron/export-watchdog.js` | 獨立持有交付匯出的 ffmpeg；主程序中斷後停止子程序、刪除半成品，並提供啟動復原用的 token pipe |
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
    ├─→ 交付匯出 watchdog ─→ ffmpeg
    ├─→ ffprobe／預覽快取 ffmpeg（child_process.spawn）
    └─→ mpv 子行程（spawn）
```

---

## 2. IPC 通訊機制

### 所有通道一覽（`electron/preload.js` 暴露的介面）

| `window.subtool` 方法 | IPC Channel | 方向 | 說明 |
|---|---|---|---|
| `status()` | `app:status` | R→M | 回傳 `{isDesktop, ffmpeg, ffprobe, ffmpegPath, ffprobePath, venc, platform, arch, ffmpegDetection, ffprobeDetection}`；兩份 detection 含逐候選探測結果 |
| `fileURL(path)` | `fs:fileURL` | R→M | 已授權唯讀檔案 → 可播放 URL；查詢不會取得新授權 |
| `stat(path)` | `fs:stat` | R→M | 已授權唯讀檔案才回傳 `{exists, size}` |
| `getFilePath(file)` | —（preload 內直接呼叫 `webUtils.getPathForFile`，無 IPC） | R | 拖放的 `File` 物件 → 絕對路徑。Electron 32 起 `File.path` 已移除；只接受真正的 File 物件、失敗回 `null`。供拖放影音走桌面載入路徑（`loadDesktopMedia`） |
| `authorizeDroppedFile(file)` | `fs:authorizeDroppedFile` | R→M | preload 從真實拖放 `File` 取得精確路徑後，授予該單一影音檔唯讀能力 |
| `readB64(path)` | `fs:readB64` | R→M | 只讀已授權檔案，回傳 base64 字串 |
| `writeProject(path, b64)` | `fs:writeProject` | R→M | 只可寫回已選取專案本身或其 `.subtool_AutoSave/` |
| `writeScreenshot(path, b64)` | `fs:writeScreenshot` | R→M | 只可寫入已授權截圖目錄的 `.jpg/.jpeg/.png` |
| `reserveScreenshotPath(directory, suffix)` | `fs:reserveScreenshotPath` | R→M | 在已授權截圖目錄內保留下一個 `Shot-NNN*.jpg`；檔案清單不交給 renderer |
| `listDir(path)` | `fs:listDir` | R→M | 只列出已選擇的交付目錄，供交付同名衝突提示 |
| `openMedia()` | `dialog:openMedia` | R→M | 系統開檔對話框（影音），為每個回傳檔授予精確唯讀能力 |
| `openAudio()` | `dialog:openAudio` | R→M | 系統開檔對話框（音訊），每個回傳檔都取得精確唯讀能力 |
| `openProject()` | `dialog:openProject` | R→M | 開啟 `.subtool` 專案，回傳 `{b64, path}`；只解析明確 media 欄位並授予那些精確來源 |
| `saveProject(name, b64)` | `dialog:saveProject` | R→M | 另存 `.subtool` 專案並授予該專案與 autosave 的限定寫入能力 |
| `importSub(kind)` | `dialog:importSub` | R→M | 開啟字幕檔，回傳 `{b64, name}` |
| `exportSub(name, b64, ext)` | `dialog:exportSub` | R→M | 儲存字幕檔，回傳儲存路徑 |
| `importDirectory()` | `dialog:importDirectory` | R→M | 選一個資料夾後批次讀入其中的 `.json`（常用樣式批次匯入用）；回傳的 `name` 是**相對於所選資料夾的路徑**，呼叫端據此還原樣式資料夾結構 |
| `importFont()` | `dialog:importFont` | R→M | 匯入字型檔，複製進使用者資料夾（`userData`，避免安裝目錄的 Windows 寫入權限問題） |
| `exportVideo(opts)` | `ffmpeg:exportVideo` | R→M | 將凍結後的影片序列加入持久化佇列並回傳工作 ID：`format` 只可為 `'h264'\|'prores'\|'wav'`，輸出副檔名必須分別是 `.mp4/.mov/.wav`。影像／音訊都必須是已授權母素材，輸出必須來自原生選取的交付位置；handler 會拒絕 `proxy.mp4`／`chN.m4a` 快取與任意 `presetOut`。同一 filtergraph 疊合片段與靜態圖片（`type:'image'` 會以 `-loop 1` 供應全段）、燒字幕，選用時再疊交付用時間碼。 |
| `stopExport(jobId)` | `ffmpeg:stopExport` | R→M | 停止主狀態列目前顯示的匯出工作；傳入 jobId 避免並行時停止到另一份工作 |
| `openQueueMonitor()` | `queue:openMonitor` | R→M | 顯示／聚焦獨立的匯出佇列監控視窗 |
| `queueResume()` | `queue:resume` | R→M | 解除佇列層級暫停並開始下一份等待工作 |
| `onQueueStatus(cb)` | `queue:getStatus` + `queue-status` | R→M + M→R | 註冊後先主動取得、之後持續接收 `{waitingCount,missingCount,isPaused}`，確保重啟恢復的工作不會因監聽時序而漏掉提示 |
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
| `mpv.detect()` | `mpv:detect` | R→M | 回傳 `{available, supported, exe}`；Apple Silicon 第一版固定 `supported:false` |
| `mpv.launch(opts)` | `mpv:launch` | R→M | Windows 啟動 mpv 嵌入播放（`{src, bounds, audio}`）；其他平台 fail closed |
| `mpv.seek(t)` | `mpv:seek` | R→M | 跳轉播放位置（**來源時間**；影片序列的時間軸↔來源映射在前端 media.js 處理） |
| `mpv.loadfile(p)` | `mpv:loadfile` | R→M | 影片序列跨段切換：同一 mpv 實例換檔（保留 --wid 嵌入與屬性），輪詢 duration 就緒後回傳 `{duration}`；只接受 FileAuthority 已授權來源 |
| `mpv.play()` / `mpv.pause()` | `mpv:play` / `mpv:pause` | R→M | 播放 / 暫停 |
| `mpv.mute(v)` | `mpv:mute` | R→M | 靜音切換 |
| `mpv.rate(r)` | `mpv:rate` | R→M | 播放速率 |
| `mpv.brightness(v)` | `mpv:brightness` | R→M | 設定 mpv 畫面亮度（−100～0）。淡入淡出的預覽提示用：HTML 疊層蓋不過 mpv 的 OS 層視窗，故改以 brightness 呈現「淡到黑」 |
| `mpv.screenshot(p)` | `mpv:screenshot` | R→M | 由 mpv 直接截圖到已授權截圖位置（含字幕）；限定圖片副檔名，固定暫存截圖只取得精確 read capability |
| `mpv.subVisible(v)` | `mpv:subVisible` | R→M | 切換 mpv 的 libass 字幕顯示（拖曳字幕時暫時隱藏，改由 HTML 層預覽新位置） |
| `mpv.setBounds(b)` | `mpv:setBounds` | R→M | 更新 mpv 覆蓋視窗位置與大小 |
| `mpv.setGuide(g)` | `mpv:setGuide` | R→M | 更新一般安全框／字幕操作 guide |
| `mpv.setImageGuide(data)` | `mpv:setImageGuide` | R→M | 將圖片疊層 HTML 與播放器矩形交給透明 guide 顯示；guide 永久穿透，實際互動由主 renderer 的 `#imageLayer` 處理 |
| `mpv.onImagePointer(cb)` | `mpv:imagePointer` | M→R | 保留的白名單 `start/move/end/cancel` 座標通道；現行互動不可依賴 guide hover 或 `enter/leave` 切換 |
| `mpv.setTimecodeWatermark(data)` / `clearTimecodeWatermark()` | `mpv:setTimecodeWatermark` / `mpv:clearTimecodeWatermark` | R→M | 在原生 mpv 畫面上顯示／清除僅監看的時間碼，資料為 `{text,rect}`；不經 ASS、不會燒進輸出 |
| `mpv.show(v)` | `mpv:show` | R→M | 顯示 / 隱藏 mpv 視窗。mpv 為 OS 層子視窗、HTML z-index 蓋不過：前端 `_syncMpvPanel()`（app.js）在對話框（含快捷鍵設定）、重疊影片的浮動面板／搜尋視窗／右鍵選單開啟時自動呼叫此方法讓位，關閉後恢復（`mpv:sync` 事件） |
| `mpv.subSet(ass)` | `mpv:subSet` | R→M | 餵入 ASS 字幕（防抖 100ms） |
| `mpv.quit()` | `mpv:quit` | R→M | 關閉 mpv |
| `mpv.onEvent(cb)` | `mpv:event` | M→R | mpv 事件推播（`time-pos`, `duration`, `pause`, `eof` 等） |

### 設定 / 字型 / 應用生命週期（v4.23 以後陸續加入）

| `window.subtool` 方法 | IPC Channel | 方向 | 說明 |
|---|---|---|---|
| `isDesktop` | —（preload 內的常數 `true`） | — | 前端 `state.js` 用它判定桌面版（`DESK`）；網頁版沒有 `window.subtool`，取值為 undefined |
| `fontsList()` | `fonts:list` | R→M | 掃 `font/` 下每個子資料夾，回傳 `{fonts:[{name, file, family}]}`。`name`＝資料夾名（UI 顯示）、`family`＝**字型檔內部家族名**（ASS 要用這個，見鐵律 §0.3）。此 handler 只授予已掃描字型根的唯讀能力，renderer 才取得到 `fs:fileURL` |
| `configLoad()` | `config:load` | R→M | 讀 `%APPDATA%/sub-tool/config.json`（設定、常用樣式 `subPresets` 等） |
| `configSave(data)` | `config:save` | R→M | **淺層合併**寫回 config.json（只傳要改的鍵即可） |
| `keysLoad()` | `keys:load` | R→M | 讀自訂快捷鍵對應表 |
| `keysSave(data)` | `keys:save` | R→M | 寫自訂快捷鍵對應表（快捷鍵設定視窗另有匯出／匯入 JSON 檔） |
| `exportDirectory(files)` | `dialog:exportDirectory` | R→M | 選資料夾批次寫入字幕樣式包；只有 `files` 為空的「選擇交付目錄」流程會授予 ffmpeg delivery capability |
| `getStartupFile()` | `app:getStartupFile` | R→M | 取「雙擊 `.subtool` 啟動」時帶進來的檔案路徑（前端啟動後主動問一次） |
| `onOpenFile(cb)` | `app:open-file` | M→R | 程式已在執行時又雙擊 `.subtool` → 推播路徑 |
| `onAppRequestClose(cb)` | `app:request-close` | M→R | 使用者按視窗關閉鈕 → 主行程**先攔下來**問前端（前端跳「未儲存」確認） |
| `closeApp()` | `app:close` | R→M | 前端完成未儲存確認後關閉主視窗；監控視窗仍開啟時改為隱藏主視窗，以保留 renderer 與專案狀態。**還有工作在轉檔（`liveWorkCount() > 0`）時不結束程式**，改為叫出監控視窗並隱藏主視窗（見下方「視窗關閉與轉檔中的工作」） |

### 匯出佇列監控視窗（`electron/queue-preload.js`）

| `window.queueAPI` 方法 | IPC Channel | 方向 | 說明 |
|---|---|---|---|
| `getAll()` | `queue:getAll` | R→M | 取得全部工作、暫停狀態與並行數 |
| `setPause(v)` | `queue:pause` | R→M | 設定佇列層級暫停；不會中斷已經執行中的工作 |
| `setConcurrency(v)` | `queue:setConcurrency` | R→M | 設定同時執行數（1–3） |
| `stopJob(id)` | `queue:stopJob` | R→M | 停止工作；執行中會要求 watchdog 結束 ffmpeg，等程序關閉後再刪除半成品與釋放輸出鎖 |
| `retryJob(id)` | `queue:retryJob` | R→M | 重新驗證來源後，以原本凍結快照重試 |
| `clearJob(id)` | `queue:clearJob` | R→M | 清除工作紀錄及其 JSON／ASS 暫存與失敗 log |
| `clearCompleted()` | `queue:clearCompleted` | R→M | 清除所有已完成工作 |
| `reorderJob(id,index)` | `queue:reorderJob` | R→M | 調整等待工作順序並同步寫回持久化檔 |
| `showMainWindow()` | `app:showMainWindow` | R→M | 顯示／重建主視窗；用於主視窗關閉後從監控視窗返回 |
| `openPath(path)` | `app:openPath` | R→M | 只可用系統預設程式開啟受控 `<userData>/export-queue/*.log` |
| `showItemInFolder(path)` | `app:showItemInFolder` | R→M | 只可在檔案總管顯示已通過驗證的精確交付輸出檔 |
| `onUpdate(cb)` | `queue:update` | M→R | 佇列內容或狀態變更通知 |

佇列的持久化真相來源在 `<userData>/export-queue/`：`ExportQueueState` 是唯一的記憶體順序來源，
每份可恢復工作各有一個
`<id>.json`，有字幕時另存 `<id>.ass`，失敗記錄固定為 `<id>.log`。新增與排序都會原子寫入；程式重啟後，
`running` 一律退回 `queued`，所有恢復工作保持暫停，直到使用者明確按「繼續佇列」。
恢復及開始前都會驗證 `clips[].path`、片段音訊及 `audioPlan` 的來源；缺檔工作標為
`missing-source`，不會靜默輸出缺字幕或缺素材的成品。恢復 app 自己持久化的工作時，才重新授予
snapshot 中每個精確來源與輸出檔的能力；renderer 後來附加的 payload 路徑仍會被拒絕。格式或副檔名
不符的工作會失敗，不能以錯誤容器交付。`done`／`failed`／`stopped` 是 **terminal**：
`persistJob()` 寫完立刻刪檔、`loadJobs()` 讀到殘留的 terminal 記錄也會刪掉並跳過。
**這是安全設計，不是疏漏**——它保證已完成的工作不會在重啟後被誤當 `queued` 重跑，
以 `-y` 覆寫掉已經交付出去的成品（見 `tests/queueStore.test.js`）。

### 匯出工作的狀態機（`electron/export-job-status.js`；v5.11.0 起）

工作有七種狀態，以及四個「這個狀態算什麼」的分類。**它們只有這一份定義**：

| 分類 | 成員 | 誰在讀 | 漏掉的後果 |
|------|------|--------|-----------|
| `terminal` | done／failed／stopped／stopping | `queue-store` 的墓碑機制 | 已完成的工作重啟後被當 `queued` 重跑，以 `-y` 覆寫已交付的成品 |
| `restorable` | queued／running／missing-source | `queue-store.loadJobs()` | 重啟後工作整批消失 |
| `liveWork` | running／stopping | 兩個關閉決策、並行度 | 關閉程式時把轉檔中的工作連同 ffmpeg 一起殺掉 |
| `retryable` | failed／stopped／missing-source | 重試 | 把還在跑的工作推回佇列 |
| `reservesOutput` | queued／running／stopping／missing-source | 輸出 lease | 兩份工作同時以 `-y` 寫同一個檔案 |

兩條不變量寫在測試裡（`tests/exportJobStatus.test.js`），新增狀態卻不分類就會紅：

- `terminal` 與 `restorable` **互斥且窮盡**——磁碟上的每一筆記錄，重開程式時不是被恢復、
  就是被當墓碑刪掉，沒有第三種。
- `liveWork` 與 `terminal` **刻意重疊於 `stopping`**：ffmpeg 還活著（關閉程式要先問），
  但萬一程式在這個狀態下死掉，那筆工作不該被恢復。**這不是筆誤。**

> v5.11.0 之前，狀態是散在 `electron/` 的 46 處字面字串，而上面五份分類分別住在
> `queue-store.js`、`main.js`、`export-queue-state.js` 三支檔案裡。新增一種狀態時，
> 沒有任何機制告訴你「還有三個地方要表態」，而漏掉其中一個**不會報錯**。

### 完成紀錄（`history.json`）

使用者需要「關掉軟體後仍看得到交付了什麼」，但上面那條 terminal 規則不能動。因此
完成紀錄走**另一條路**：`<userData>/export-queue/history.json`，由
`electron/queue-history.js` 維護。

- 只存 `id`／`status:'done'`／`createdAt`／`completedAt`／`elapsedMs` 與
  `payload` 的 `outPath`／`duration`／`format` —— 也就是 `queue.html` 的
  `createJobCard()` 渲染完成卡片實際會用到的欄位，**其餘一律不存**。
- 沒有 `clips`／`audioPlan`／`assRef`／`sourcePaths`，所以它**本質上不可執行**；
  `restoreJobs()` 把它們以 `done` 身分放回 `ExportQueueState`，`nextQueued()`
  永遠不會選到，`OUTPUT_RESERVED_STATUSES` 也不含 `done`（不會擋住同路徑重新匯出）。
- 上限 200 筆，超出丟最舊的。JSON 損毀或版本不符時**回空陣列而不是拋錯**——
  稽核資料不該擋住程式啟動。
- `queue:clearJob`／`queue:clearCompleted` 必須**同時**清掉 `history.json`，
  否則使用者清掉的紀錄下次啟動又會回來。

### 視窗關閉與轉檔中的工作

`prepareForShutdown()` 會停掉執行中的 ffmpeg 並清半成品，所以任何「會結束程式」的
路徑在還有工作轉檔時都必須先擋下來：

| 情境 | 行為 |
|------|------|
| 關閉主視窗，監控視窗開著 | 隱藏主視窗（保留 renderer 與專案狀態），既有行為 |
| 關閉主視窗，`liveWorkCount() > 0` | **不結束程式**：`openQueueWindow()` ＋ `hideMainWindow()`，轉檔繼續 |
| 關閉主視窗，沒有工作在轉檔 | 正常關閉流程 |
| 關閉監控視窗，主視窗還開著 | 直接關（只是收起監控畫面，轉檔照跑），不打擾 |
| 關閉監控視窗且這次關閉會結束程式（`queueWindowCloseEndsApp()`）、`liveWorkCount() > 0` | `preventDefault()` ＋ `dialog.showMessageBox` 確認；預設與 `Esc` 都落在「繼續轉檔」 |

`queueWindowCloseEndsApp()` ＝ 主視窗已不存在，或主視窗是為了讓監控視窗獨自存在而被隱藏
（`_mainHiddenForQueue`）——也就是 `closed` handler 會呼叫 `app.quit()` 的那兩種情況。

交付匯出另在 `<userData>/export-queue/output-leases/<SHA-256>.lock/owner.json`
記錄輸出路徑所有權。同一路徑在 `queued`／`running`／`stopping`／`missing-source`
任一狀態已被保留時，新工作與重試都會回報 `OUTPUT_BUSY`，不會等前一份結束後再以
`-y` 覆寫。每個執行中的工作由獨立 watchdog 持有 ffmpeg；正常停止會先等 ffmpeg
真正關閉，才刪半成品並以 owner token 釋放 lease。若主程序被工作管理員強制終止，
watchdog 會由 IPC disconnect 進入同一套清理；Windows 若連 watchdog 一起被終止，
下次啟動會在還原工作 JSON **之前**復原殘留 lease。

啟動復原只透過 owner 的 token pipe 確認仍存活的 watchdog；pipe 不存在時視為 stale，
只刪半成品並以正確 token 釋放 lease，**絕不依持久化 PID 直接 taskkill**，避免 PID
被 Windows 重用後誤殺其他程序。`owner.json` 損壞、token 不符或半成品刪除失敗時一律
fail closed：保留 lease 並記錄警告，不能在身份或清理結果不明時放行同一路徑。

主視窗與監控視窗的關閉語意不同：監控視窗存在時關主視窗只會隱藏主視窗，
可用 `app:showMainWindow` 原樣叫回；接著再關監控視窗才會真正退出程式。判斷使用
明確的 `_mainHiddenForQueue` 旗標，不可用 `BrowserWindow.isVisible()` 代替，因為
Windows 最小化時它也可能回傳 `false`。

> **新增 IPC 通道時**：① `preload.js` 加 `ipcRenderer.invoke`；② `main.js` 加 `ipcMain.handle`；③ 更新此表。
>
> **路徑安全**：主行程唯一權威是 `FileAuthority`，而不是「看過路徑就授權」的資料夾白名單。
> 原生對話框、OS 開檔、preload 驗證的真實拖放 `File` 與 app 自己持久化的 queue snapshot 才能授予
> capability。read、project/autosave write、delivery write、screenshot write、queue log shell-open 與
> delivery reveal 各自分離；新增 IPC 時必須選對能力，不能用 `fs:fileURL`／`stat`／任意 payload 當升權入口。

---

## 3. 開發環境

### 前置需求

- Node.js 18+（`npm install` 安裝 Vite / Electron 相依）
- ffmpeg / ffprobe（MXF / 多音軌功能）：Windows 發版機使用 `electron/ffmpeg/*.exe`；
  Apple Silicon 由 `npm run native:prepare:mac` 準備 `electron/ffmpeg/darwin-arm64/`
- mpv（Windows 秒開功能）：放在 `electron/mpv/`；macOS 第一版不啟用 Windows 專用嵌入

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

### 路徑偵測順序（`native-tooling.js`）

| 順位 | Windows | Apple Silicon macOS |
|------|---------|---------------------|
| 1 | `electron/ffmpeg/<tool>.exe` | `electron/ffmpeg/darwin-arm64/<tool>` |
| 2 | `resources/app.asar.unpacked/electron/ffmpeg/<tool>.exe` | `resources/app.asar.unpacked/electron/ffmpeg/darwin-arm64/<tool>` |
| 3 | `FFMPEG_PATH`／`FFPROBE_PATH` | 同左 |
| 4 | PATH 中的 `ffmpeg`／`ffprobe` | 同左 |
| 5 | `C:\Program Files\FFMPEG\bin\`、`C:\ffmpeg\bin\` | `/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`、`~/.local/bin` |

每個候選都真的執行 `-version`；`app:status` 回傳最後採用路徑及每次探測的 status／signal／
error code，不能再只靠「檔案存在」推定可執行。

`electron/ffmpeg/` 與 `electron/mpv/` 刻意不進版控。Windows 發版機仍需手動放好 gyan
full_build 與 mpv（約 538 MB；見 §7）。Apple Silicon 則由固定版本的 `ffmpeg-static` 與
`@derhuerst/ffprobe-static` 在 **darwin/arm64 本機**下載正確架構，複製相鄰的 LICENSE／
README，並實際探測 `ass`、`libx264`、`prores_ks`、`pcm_s24le`、`mxf` 後才允許打包。

`scripts/verify-native-binaries.js` 是 Windows/macOS 共用的唯一封裝需求檢查器：Windows 要求
ffmpeg.exe、ffprobe.exe、mpv.exe、d3dcompiler_43.dll；darwin-arm64 只要求 ffmpeg/ffprobe，
並額外檢查 Unix executable bit。Windows `predist` 明確帶入 `win32/x64`，`dist:mac:test`
明確帶入 `darwin/arm64`；
`tests/verifyNativeBinaries.test.js` 真的餵缺檔與殘檔情境，不只比對 script 字串。

### 硬體視訊編碼器偵測

Windows 啟動時依序測試 `h264_nvenc` → `h264_qsv` → `h264_amf`；macOS 測試
`h264_videotoolbox`。全部失敗才用 `libx264`。結果存入 `VENC`。
可在 DevTools console 執行 `await window.subtool.status()` 查看 `venc` 欄位。

### 轉檔輸出規格

- **Proxy 影片**：720p、yuv420p；libx264 CRF 26、NVENC cq 26、QSV global_quality 26、
  VideoToolbox 4 Mbps realtime
- **聲道音訊**：AAC 128kbps `.m4a`
- **波形用音訊**：8kHz mono 16-bit PCM WAV

> 上列三者皆為**預覽／波形快取**，絕不可作為匯出輸入。影片匯出重讀母素材；MP4 對經混音／編組後的交付 stream 重新編 AAC（Mono 192k／Stereo 320k／5.1 640k），ProRes 與 WAV 使用 24-bit PCM。若母素材也已作為影片 input，音訊 filtergraph 必須重用該 input，而非另開同檔造成雙重磁碟讀取。

### 交付匯出的崩潰隔離

MP4／ProRes／WAV 的佇列工作不由 Electron main 直接持有 ffmpeg，而是由
`export-watchdog.js` 啟動並監護；進度與 stderr 經 IPC 回傳 main。Proxy、ingest、
波形等可重建的短期快取仍由 main 直接 spawn，以免把持久化工作語意套到快取流程。
watchdog 必須在成功取得輸出 lease 後才可啟動 ffmpeg；結束碼非 0、使用者停止、
main IPC 中斷時都必須先確認 ffmpeg 已關閉，再處理半成品。刪除失敗時保留 lease，
讓後續工作無法靜默覆寫尚未清乾淨的路徑。

### 媒體快取

快取鍵 = `SHA-1(basename + size + 前 1MB 內容)`（不含修改時間，跨電腦可用）

候選目錄（依序讀取第一個有效的、寫入第一個可寫的）：
1. 影片所在目錄旁的 `.subtool_Cache/<key>/`
2. `<userData>/mediacache/<key>/`（`CACHE` = `app.getPath('userData')`；Windows 通常在
   `%APPDATA%\sub-tool`，macOS 通常在 `~/Library/Application Support/sub-tool`）

暫存路徑：`path.join(os.tmpdir(), 'subtool_cache')`（程式退出時清除）。

---

## 5. mpv 嵌入整合（Windows-only）

Windows 的 mpv 以**子視窗**方式嵌入：Main Process 啟動 `_mpvWin`（無框 BrowserWindow）
並用 `--wid=<HWND>` 蓋在播放區域上方。這條實作依賴 Windows HWND、D3D compiler 與
`\\.\pipe\...` named pipe，不能只換一支 macOS mpv binary 就宣稱跨平台。

Apple Silicon 第一版由 `mpvEmbeddingSupported('darwin')` 明確回傳 false：`mpv:detect` 回報
`supported:false, available:false`，`mpv:launch` 也會 fail closed。renderer 會走現有的
ffmpeg 單次 ingest → proxy／逐聲道快取 → HTML/WebCodecs 預覽；這條路徑較慢，但不會執行
未驗證的 Windows 視窗控制碼。未來若要做 macOS mpv，必須另行設計原生視窗嵌入與 IPC，
不能移除這個平台閘門當成完成。

### 主要行為

- `mpv:launch`：Windows 啟動 mpv IPC socket（`\\.\pipe\mpvsocket_<pid>`），建立連線後送播放指令
- `mpv:event` 推播：`time-pos`、`duration`、`pause`、`eof-reached`（前端用於同步播放頭）
- `mpv:subSet`：接收 base64 ASS 字串，寫入暫存 `.ass` 後用 `sub-reload` 指令更新
- `mpv:setBounds`：更新 `_mpvWin` 位置；主視窗移動/縮放時自動呼叫
- `mpv:setImageGuide`：將圖片的 HTML 疊層（包含虛線框與控制點）交給透明 guide 視窗，僅供
  OS 層 mpv 上方顯示。guide 永久使用 `setIgnoreMouseEvents(true, { forward:true })`；實際拖曳／縮放
  一律由主 renderer 無條件建立的 `#imageLayer` DOM 處理。早期 25ms 游標輪詢與
  `enter`／`leave` IPC 都已移除；不要恢復，否則 guide 會攔截底層時間軸與右鍵選單。
- `mpv:setTimecodeWatermark`：原生 mpv 模式由 guide 顯示監看 TC；一般 HTML 預覽仍由 renderer DOM 顯示。兩者都從 `Media.displayTime()` 取得同一個時碼來源。

### 注意事項

- `_mpvWin` 與 `mainWin` 是不同的 BrowserWindow；`mainWin.minimize()` 時需手動 `_mpvWin.hide()`
- `safeSend(wc, ch, data)`：視窗關閉後 IPC 回呼可能仍在執行，必須先確認 `!wc.isDestroyed()`
- Windows mpv 版本需支援 `--input-ipc-server`；偵測失敗時 fallback 到 ffmpeg 單次轉檔

---

## 6. 打包與發布

```bash
npm run dist          # 明確鎖定 Windows x64：NSIS Setup
npm run dist:mac:test # Apple Silicon：unsigned 本機測試 DMG + ZIP
```

Windows 輸出 `release/SUB Tool Setup <版本>.exe`（NSIS）；Apple Silicon 輸出
`release/SUB Tool-<版本>-mac-arm64.dmg` 與 `.zip`，unpacked App 位於
`release/mac-arm64/SUB Tool.app`。兩個平台都關聯 `.subtool`。

`dist:mac:test` 明確設為 unsigned 並關閉 hardened runtime，只供擁有原始碼的人在自己的 Mac
驗證功能；不可上傳成正式 Release。第一階段不提供正式 Mac 發布指令；之後必須在同一個已驗收
commit 上另行加入 Developer ID、hardened runtime 與 Apple notarization 的 fail-closed 流程，
並驗證 DMG 安裝位置、Finder 檔案關聯、啟動版本及 Gatekeeper。
共通正式發布流程與人工驗收清單見 [`開發與驗證.md`](開發與驗證.md)。

**`package.json` electron-builder 設定**（實際值）：
```json
{
  "win":  {
    "target": "nsis",
    "files": [
      "dist/**/*",
      { "from": "electron", "to": "electron", "filter": ["**/*", "!ffmpeg/**", "!mpv/**"] },
      { "from": "electron/ffmpeg", "to": "electron/ffmpeg", "filter": ["ffmpeg.exe", "ffprobe.exe"] },
      { "from": "electron/mpv", "to": "electron/mpv", "filter": ["mpv.exe", "d3dcompiler_43.dll"] }
    ]
  },
  "mac":  {
    "target": [
      { "target": "dmg", "arch": ["arm64"] },
      { "target": "zip", "arch": ["arm64"] }
    ],
    "files": [
      "dist/**/*",
      { "from": "electron", "to": "electron", "filter": ["**/*", "!ffmpeg/**", "!mpv/**"] },
      { "from": "electron/ffmpeg/darwin-arm64", "to": "electron/ffmpeg/darwin-arm64", "filter": ["**/*"] }
    ]
  },
  "nsis": { "oneClick": false, "perMachine": true, "allowToChangeInstallationDirectory": true,
            "createDesktopShortcut": true, "createStartMenuShortcut": true },
  "fileAssociations": [{ "ext": "subtool", "role": "Editor" }],
  "directories": { "output": "release" },
  "extraResources":[{ "from": "font", "to": "font", "filter": ["**/*"] }],
  "asarUnpack":    [
    "electron/mpv/**",
    "electron/ffmpeg/**",
    "electron/export-watchdog.js",
    "electron/export-lease.js"
  ]
}
```

- `asarUnpack` 確保各平台 ffmpeg、Windows mpv 與獨立啟動的 export watchdog／lease 模組不被
  asar 封裝，可由 `child_process.spawn` 直接執行並在安裝版正確 `require`。
- Mac 的 platform-specific `files` 先排除整個 `electron/mpv` 與 `electron/ffmpeg`，再只加入
  `darwin-arm64` 子目錄；因此從 Windows 搬來的忽略檔不會污染 DMG。
- Windows 也先排除兩個原生工具目錄，再只加入四個 x64 必要檔；因此 Mac 建置留下的
  `darwin-arm64` 子目錄不會污染 NSIS Setup。
- **`extraResources` 是字型能不能用的關鍵**：平台 `files` 只收 `dist/` 與 `electron/`，`font/`
  必須另外用 `extraResources` 送進 `resources/font`。v4.26 少了這一段 → **開發時字型正常、
   裝起來的 exe 一個字型都沒有**（v4.27.0 修）。`fontsRoot()` 依 dev（專案根）→
   `resources/font` → 安裝目錄 順序尋找。
- `nsis.perMachine: true` 讓正式 Setup 以 UAC 安裝到 `C:\Program Files\SUB Tool` 為預設。
  Setup 會建立真正的系統安裝與捷徑，不能拿 `/D=<workspace>` 當封裝 smoke；完整防呆流程見
  [`開發與驗證.md` 的「安裝器 smoke 的安全邊界」](開發與驗證.md#安裝器-smoke-的安全邊界)。
- Windows 換 ffmpeg build 前先讀 §7 與變更紀錄：**BtbN 的 gpl-shared 版會截斷多串流
  MXF 的音訊**，目前固定用 gyan full_build。Mac static build 雖有能力探針，仍必須拿同一支
  真實多音軌 MXF 驗證，不能用 `-demuxers` 列得到 `mxf` 當成內容正確。

---

## 7. 常見問題排查

| 症狀 | 檢查項目 |
|------|----------|
| 主視窗無法啟動 | 確認 `npm install` 完成；檢查 `electron/main.js` Node 相依 |
| 前端無法呼叫 `window.subtool` | `preload.js` 是否正確載入；`contextBridge.exposeInMainWorld` 是否成功 |
| ffmpeg 功能無效 | `await window.subtool.status()` → 看 `ffmpegPath` 與 `ffmpegDetection.attempts`；安裝版應先命中 `app.asar.unpacked`，不是只確認 PATH |
| 影片黑畫面（4:2:2）| ffmpeg 未加 `-vf format=yuv420p`；proxy 輸出格式不相容 |
| mpv 無法啟動 | 只適用 Windows：確認內建 mpv 與 `d3dcompiler_43.dll`；socket `\\.\pipe\mpvsocket_<pid>` 是否衝突。macOS 的 `supported:false` 是第一版預期行為 |
| GPU 編碼器不可用 | Windows 確認顯示卡驅動；Mac 確認 static ffmpeg 列出且能實跑 `h264_videotoolbox`；`status()` 回傳 `libx264` 表示已 fallback |
| Mac App 被 Gatekeeper 擋下 | `dist:mac:test` 是 unsigned，只能對自己剛建出的可信產物依 Apple「隱私權與安全性 → 仍要打開」放行；公開版本必須 Developer ID 簽署與 notarize |
| Mac DMG 異常巨大或含 `.exe` | 檢查 `build.mac.files` 是否仍先排除 `electron/ffmpeg/**`、`electron/mpv/**` 再只加入 `darwin-arm64`；解開 App 實看內容，不能只看 build 成功 |
| Mac 選完輸出目錄卻被 fileAuthority 拒絕 | 檢查 renderer 送出的 `outPath` 是否把 POSIX 目錄組成 `Output\\file.mp4`。`delivery-list.js` 必須依原生選擇器回傳格式保留 `/` 或 `\\`，不能固定使用 Windows 分隔符；POSIX 根目錄與 Windows 磁碟根目錄都有單元測試 |
| 快取未命中（每次都重新轉） | 來源檔前 1MB 或大小有變動；可手動刪除 `.subtool_Cache` 強制重建 |
| `task-progress` 無回報 | `sender` 是否傳入 `runFF`；`safeSend` 是否因視窗已銷毀而跳過 |
| **完全無法匯出影片**（filterchain 解析失敗） | `fontsdir=` 的 Windows 磁碟機冒號要跳脫**兩層**（`C\\:/`）。單反斜線會讓 ffmpeg 把 `:` 當選項分隔符。注意手動在 shell 跑也會撞到同一個錯，很容易誤判成「shell 吃掉跳脫字元」——用 `spawn`（無 shell 介入）重測才能確認 |
| 匯出的字幕**字型不對**（變成微軟正黑體） | ASS 的 Fontname 必須是**字型檔內部家族名**（`fontsList()` 回的 `family`），不是資料夾名。libass 配不到會**靜默**退回，沒有錯誤訊息——查 libass 的 `fontselect:` 輸出，退回旗標 1 ＝ 沒配到 |
| 安裝版沒有任何字型可選 | `package.json` 少了 `extraResources`（見 §6） |
| 使用者說某個按鈕「按了沒反應」 | 是不是用到了 `window.prompt()`？**Electron 停用了它**，回傳永遠是 null，靜默失敗。改用 `ui.js` 的 `promptModal()` |
| HTML 疊層（字幕拖曳、安全框）在 MXF 模式下看不到 / 點不到 | mpv 是 **OS 層 always-on-top 子視窗**，蓋在所有 HTML 之上；需要 `mpv.show(false)` 讓位（`_syncMpvPanel()`） |
| 圖片在 mpv 預覽看得到框但不能拖曳，或拖曳時字幕／安全框消失 | guide 視窗**刻意永久穿透**，互動一律由主視窗的 `#imageLayer` DOM 處理（見 `技術架構說明.md` §0.9）。請檢查：1. `main.js` 的 `setIgnoreMouseEvents(true, { forward: true })` 是否被改成有條件切換；2. `#imageLayer` 是否仍為**無條件建立**（不可只在非 mpv 模式建立）。**不要**把 `enter`／`leave` 加回 `mpv-guide-preload.js` 的白名單——那條路徑從未執行過（送出端沒帶座標，在 x/y 檢查就被丟掉），已於 v5.2.3 移除；接回去反而會讓 guide 在 hover 時奪取指標，底層視訊軌拖曳與右鍵選單全部失效。 |
| 圖片匯出只顯示第一格或後段變黑 | 檢查 renderer 是否保留 `clip.type === 'image'`；主程序必須對該輸入加 `-loop 1 -framerate <project fps>`，並把每個 clip 的 `scale/posX/posY` 傳進 filtergraph。 |
| TC 監看在 mpv 模式不顯示 | 先確認播放器 TC 開關為開，再檢查透明 guide 是否建立；這是監看 overlay，與匯出視窗的「壓入時間碼浮水印」為兩個獨立開關。 |
| 解除影音顯示無法建立獨立音訊 | 不要以 Chromium `<audio>` 直接讀 MXF／部分 MOV 容器；確認 `ffmpeg:ingest` 有產出逐聲道 `.m4a` 快取，並確認還原資料保留 `preferCache:true` |
| 匯出 MP4 的音訊 bitrate 看似偏低 | 先看匯出完成狀態的「音訊 AAC 實測」。確認使用新版安裝檔；該值是輸出 AAC，而不是母素材原始 bitrate。若需要無損音訊，改用 ProRes（24-bit PCM）或 WAV。 |
| 同一路徑無法再加入或重試匯出 | 先看監控視窗是否仍有 `queued`／`running`／`stopping`／`missing-source` 工作保留該路徑。若 `<userData>/export-queue/output-leases/` 仍有鎖，先完整重啟讓啟動復原處理；不要直接刪 `owner.json` 或依其中 PID 手動 taskkill。 |
| 強制關閉後留下半成品或輸出鎖 | 重啟一次，確認啟動復原會在載入佇列前刪除 stale 半成品並釋放 lease。若仍保留，查看終端機的 `[Export watchdog]` 警告；通常代表 `owner.json` 損壞或檔案被其他程式占用，系統刻意 fail closed。 |

---

## 8. 變更紀錄

各版本詳細變更請見 [`版本變更紀錄.md`](版本變更紀錄.md)。

每次修改 IPC 通道或架構後，請同步更新本文件第 2 節通道列表。
