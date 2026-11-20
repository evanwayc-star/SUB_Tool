# SUB Tool Electron 維護手冊

桌面問題可依下表定位。API 的完整參數在各視窗 preload，檔案授權、時間換算及原生程序的生命週期由對應的主程序模組負責。

| 問題 | 直接閱讀 |
|---|---|
| 開檔、儲存、重連、授權、本機 URL | [§2 檔案能力](#2-安全與檔案能力) |
| renderer 方法對到哪個 IPC 或 sender | [§3 Preload](#3-preloadipc-介面) |
| Proxy 重轉、NAS 快取慢、聲道或波形錯誤 | [媒體 intake](#媒體-intake) · [Proxy GPU](#proxy-的-gpu-路徑) · [音量表](#原音電平取樣) |
| 交付覆寫、取消、失敗後重試 | [交付](#交付) · [§6 匯出佇列](#6-匯出佇列) |
| mpv 黑畫面、定位、原生截圖或遮擋 | [§5 mpv](#5-mpv-嵌入整合windows) · [§8 排查](#8-排查) |

## 1. 系統總覽

Renderer 透過 contextBridge 呼叫 main。`main.js` 組裝視窗與下列模組。修改行為時從負責資料或程序生命週期的模組開始。

| 工作 | 主要入口（均在 `electron/`） |
|---|---|
| 檔案准入／提交 | `file-authority.js`、`ipc-guards.js`、`project-file-authority-engine.js`、`file-commit-coordinator.js`、`file-content-evidence.js` |
| 檔案輸出／設定 | `directory-output.js`、`style-directory-import.js`、`screenshot-output.js`、`settings-file.js`、`local-resource.js` |
| 來源與預覽 | `mother-source-evidence.js`、`media-probe.js`、`media-source-clock.js`、`media-intake-runtime.js` |
| 波形與片段快取 | `source-waveform-task.js`／`source-waveform-worker.js`、`continuous-source-waveform.js`／`continuous-waveform-cache.js`、`clip-frame-cache.js`／`clip-audio-cache.js` |
| 音訊 | `native-audio-meter.js`、`audio-normalization-runtime.js`、`audio-effect-cache.js`、`vocal-waveform-runtime.js`、`speech-audio-reader.js`／`speech-audio-compressor.js` |
| mpv／視窗 | `mpv-host.js`、`mpv-window-region.js`、`compare-window.js` |
| 交付准入／計畫／執行 | `delivery-consent.js`、`delivery-runner.js`、`export-plan.js`、`ffmpeg-execution-engine.js` |
| 排程／成品／復原 | `export-queue.js`、`queue-store.js`、`export-watchdog.js`、`export-lease.js`、`export-artifact.js`、`owned-output-handle.js`、`diagnostic-log.js` |

產品操作見[使用說明](使用說明.md)，renderer 資料流見[技術架構](技術架構說明.md)，驗收與發版命令見[開發與驗證](開發與驗證.md)。

## 2. 安全與檔案能力

保留 `contextIsolation:true`、`nodeIntegration:false`、`webSecurity:true`。Preload 只暴露各視窗指定能力，main 依真實 sender、路徑與既有授權再檢查。Renderer 的 path、bytes 或通過型別檢查的物件都不能增加權限。

### 拖放

- 以 `webUtils.getPathForFile()` 從真實 File 取路徑。一般素材送 `fs:authorizeDroppedFile`。`.subtool`／`.json` 走 `project:openDroppedFile`，由 main 讀可信專案。
- 樣式目錄只讀所選根內的一般 JSON，拒絕子層 junction／symlink。只回內容。單檔與批次字幕／XLSX 走 `directory-output.js`。批次分別回報寫入、略過、衝突，保留已成功的檔案。

### 專案

1. **開啟與重連**。原生選擇、拖放、最近清單、啟動參數與 OS 開檔都以 main 讀到的可信 bytes 為準。捕獲父目錄身分、用同一 handle 取 bytes，再核對路徑與內容。只讓目前請求授予宣告媒體權限、更新最近清單。重連限目前專案宣告的同名一般檔，逐層重核根及目錄身分。最近清單依穩定 token 開啟，缺檔或暫時 I/O 失敗保留紀錄。
2. **原目錄與目的檔**。原專案及自動備份沿用選檔時的父目錄資格。另存來自原生選擇，媒體須已有讀權。所選根可以是連結／掛載點，根下逐層核對並拒絕改向。子根資格失效不回退祖先授權。Windows native realpath 展開 8.3 短名，再核對 dev／ino。不同 hardlink 名稱仍為不同目錄項。
3. **並行提交**。專案、字幕、樣式及截圖經 `file-commit-coordinator.js` 依實體父目錄＋目的檔名排序。同一項依准入順序，不同項可並行。批次先保留合法目的再送 worker，退出等已准入工作收尾。
4. **發布與失敗**。專案以 `wx`、目錄輸出以 `wx+` 建私有暫存。write／sync／close 後核根、目的檔、暫存身分與完整預期 bytes，再同目錄 rename。SMB 可能到關檔才更新時間戳，須驗同一檔案、mode、長度、完整 SHA-256 及讀前後快照，才採用關檔後時間。目的變動就保留原檔及衝突資訊。暫存未寫完時只清能證明歸屬的內容，未知部分保留。sync 失敗不發布。硬連結使用替換目錄項，避免截斷其他名稱的內容。

以上為程式內排序與分階段身分核對。`realpath/lstat`、開檔、rename 與 unlink 分屬不同 syscall，不能保證阻止其他程序在最後檢查後換檔。[可信專案](../tests/trustedProjectIntake.test.js) · [跨工作寫入](../tests/directoryOutputCrossWriter.test.js)

### 本機資源 URL

`subtool-local:` 的隨機 token 對應精確檔案，每次讀取核 `canExposeFileURL()`、方法、一般檔及 Range。WebAudio／canvas 讀用的媒體與圖片在設 `src` 前先設匿名 CORS，程式使用 `setMediaElementSource()`。以真實像素驗證固定畫面、截圖及圖片合成。

`protectApplicationWindow()` 限主頁、佇列、比較視窗在各自 HTML。明確 `--dev` 才允許指定的開發 origin／pathname。允許的外部 HTTP(S) 連結交給系統瀏覽器。[協定與導覽測試](../tests/localResourceSecurity.test.js)

### 設定檔持久化

`settings-file.js` 各自持有 `settings.json` 與 `key.json`。相鄰暫存發布前驗身分與內容。遇解析錯誤先備份原 bytes 至 `.corrupt-*`，無法備份就拒絕覆寫。失敗要回報。最近清單暫讀失敗不以空陣列回寫，最近目錄從交易內的 `current.lastDirs` 合併，成功才更新顯示快取。[隔離設定與 CDP](開發與驗證.md#3-真機驗證cdp)

## 3. Preload／IPC 介面

需要完整簽名、欄位、通道或事件名時，直接讀對應 preload。一般操作使用 `invoke`／Promise。`send` 無回覆，事件另有 listener 生命週期。新增入口須同步驗 sender、main 准入、preload 與回歸測試。事件包裝不把 Electron event 交給頁面。

### 主頁面：檔案、專案與應用

[主頁 preload](../electron/preload.js) 的 `window.subtool` 提供 `status`、`openProject`、`saveProject`、`writeProject`、`importSub`、`exportSub`、`exportDirectory`、`fileURL`、`cacheInfo` 及設定等方法。`isDesktop` 是值。`getFilePath(file)` 只呼叫 webUtils。`openCompareWindow`／`syncCompareWindow` 用 `send`。OS 開檔、比較命令、關窗為事件。

### 主頁面：媒體、音訊與交付

| 工作 | 方法與關鍵輸入 |
|---|---|
| 來源與載入 | `probe(path)`、`mediaSourceKey(path)`。`ingest(opts)`／`streamIngest(opts)` 傳來源、duration、音訊配置、sessionId、requestId。`prepareSourceWaveform(opts)` 以 `sourceWaveformContinuous` 判斷連續能力。`releaseStream` 只釋放該 sender 的 reader。 |
| 聲道與效果 | `audioSourceFingerprint` 對應 `audio:source-fingerprint`，`vocalWaveFingerprint` 對應 `audio:vocal-wave-fingerprint`。`normalizeAudio`／`analyzeAudioLoudness` 各帶 requestId。`audioEffectPeaks` 讀顯示資料，`releaseAudioEffect` 歸還 lease。 |
| 辨識 | `speechAudioRead` 讀授權母素材，按 stream／channel 與來源時間取得 16 kHz mono Float32，每段最多 600 秒。`speechAudioCancel` 限同 sender／request。`compressSpeechAudio` 接 44–20,000,000 bytes WAV 與壓縮 requestId，取消涵蓋 MP3 讀取及清理。 |
| 交付 | `beginDeliveryTargetRequest` → `prepareDeliveryTargets` → 各列 `exportVideo`，之後 `finishDeliveryTargetRequest` 或取消該 ticket。`stopExport(jobId)` 只停該交付，媒體取消另走 `cancelMediaIntake`。 |

### 主頁面：mpv

`window.subtool.mpv` 的 `seek`／`present` 接**來源秒數**。`present` 支援 exact、waitForFrame、tolerance 及來源格區間。`play({waitForReady:true})` 回同來源的 ready／sourceTime。`mute` 等 ACK。`audioMix` 傳來源 session、座標與 gain。`setViewport`、`setProjectCanvas` 傳驗證過的幾何。`onEvent` 替換舊 listener。擷取、guide、ASS 與 watermark 的完整方法見[主頁 preload](../electron/preload.js)。

### 獨立視窗

| 視窗 | Bridge 與限制 |
|---|---|
| 佇列 | [queue-preload.js](../electron/queue-preload.js) 的 `window.queueAPI`。只可管理工作、排程及定位允許的成品。`exactFrameRate` 是 `sendSync` 純值查詢，main 限存活佇列 sender／數字或字串。preload 最多快取 64 筆。`onUpdate` 替換舊 listener。 |
| 比較 | [compare-preload.js](../electron/compare-preload.js) 的 `window.subtool` 只有 `onUpdateData`／`sendCommand`。載入期間只保留最新快照，舊命令保留原 revision。 |

部分訂閱只追加，只有明確回傳解除函式的入口才可呼叫它，例如 `onAudioNormalizeProgress`。

## 4. ffmpeg／ffprobe 整合

### Native tool 解析

正式包必須用自身原生工具。Windows x64 將完整建置的 `ffmpeg.exe`、`ffprobe.exe` 放在 `electron/ffmpeg/`，光碟工具用 `npm run native:prepare:disc`。Mac arm64 以 `npm run native:prepare:mac` 準備 `electron/ffmpeg/darwin-arm64/` 的工具。開發時才可用環境／專案 fallback。核對封裝清單、大小、執行權與指定 SHA。實際 codec、ASS filter、MXF demux 另用執行與內容驗證。[解析與執行](../electron/ffmpeg-execution-engine.js) · [必要檔案檢查](../scripts/release/verify-native-binaries.js)

`media-probe.js` 同時最多兩個 ffprobe，排隊不算進預設 60 秒執行期限。同命令、同來源證據且無取消請求可共用。有 AbortSignal 各自持有程序。取消／逾時要等 native `close`，未確認終止不可放行。重核來源後才回報，不把途中換檔當普通 fallback。

### 媒體 intake

**工作歸屬**。main 綁定 sender，renderer 每個工作區使用非空 sessionId，每個工作使用 requestId，兩者上限 128 字元。合併排程或取消都要核對這組歸屬。`ingest({queue:true})` 排隊，`queue:false` 或 `streamIngest` 只取代同 sender 的待跑／在途工作。取消指定 request 不動同 session 其他工作。取消整個 session 也收其串流讀者。重試換 request，整 session 已取消則換 sessionId，重新核對片段與原母素材。狀態列左側是交付／操作，右側是 intake。`done:true` 只表示結束，須檢查 `outcome`。進度、終態及 IPC 回覆可能交錯。[取消與競態](../tests/mediaIntakeRace.test.js)

**波形先於 Proxy**。同一來源先保存原音波形，確認完整 WAV 後才開始 Proxy／聲道 intake。mpv 可先直讀母素材。新 bridge 傳 `continuous:true`、整份來源時長與音訊配置，舊 bridge 保留分段 `.swc`。一般／串流載入均傳 duration，核對原波形證據，重用完成 WAV 時不額外產生 MIX。個別聲道用實際 stream／channel，單聲道 AAC 明確標準 Mono。多來源 MIX 的每個原始聲道等權，短 stream 尾端補零。[來源時序回歸](../tests/mediaIntakeSourceTiming.test.js)

| 階段 | 持有者、輸入與完成證據 |
|---|---|
| 解碼與進度 | main 持有 FFmpeg，以背壓控制送往 worker 的 PCM，worker 負責 NAS 讀寫。來源時鐘對齊後，以 4000 Hz、mono、16-bit 解碼，完整樣本數為 `round(duration * 4000)`。每 40 samples 一對 min/max（100 Hz），MIX 與指定聲道分開保存。完整顯示峰值可從既有 WAV 補建。 |
| 檢查點 | `continuous-waveforms/<識別>/partial.wav` 與 `checkpoint.json` 各屬一個 writer 世代。前四段每 5 秒**來源 PCM**。素材達 120 秒時往後每 30 秒，其餘仍每 5 秒。先同步內容及更新 checkpoint，再發峰值。尾段等正常 EOF 與樣本總數吻合。rename 若遇短暫 `EPERM/EACCES/EBUSY`，最多五次，退避 25／50／100／200 ms，逐次重核歸屬。 |
| 中斷與續算 | 核對來源、配方、長度及已存前綴 SHA。複製到自己的 writer 世代，從已完成位置往前三秒的整秒解碼，比對末一秒 PCM。失配最多回起點一次比完整前綴。取消／退出保留已提交檢查點。`ignoreCached:true` 建新世代。 |
| 完成與接管 | 關閉 writer，驗完整 PCM SHA-256、總樣本數與目錄／檔案身分，發布 `wave.wav`。進度 100% 或完整峰值都不足以宣告已保存。無聲 Proxy 等聲道已交接才可接管播放。 |

來源波形與快取規則見[連續解碼](../electron/continuous-source-waveform.js)及[持久化](../electron/continuous-waveform-cache.js)。舊分段格式首段 5 秒、第二段補到 60 秒、後續至多 60 秒。`waveMixVersion`、聲道完整性及有無正式 wave 影響元件重用資格。

**來源與快取證據**。正式資產在素材旁 `.subtool_Cache`。唯讀可用已驗完成元件，缺件或寫入失敗須回報。`allowSidecarCache:false` 只供隔離驗收。完整音訊 stream／channel、來源時鐘、色彩、Proxy 配方版本及 `artifactSizes` 逐元件核對，損毀只補缺件。檔案大小不能證明每個 byte 完好。

| 證據 | 能證明與限制 |
|---|---|
| 本機 `source-v3` | 完整路徑、stat 與前／中／尾有界取樣，用於同機交接與換檔偵測。各功能保留 namespace 與能力核對。 |
| `source-v4-shared-file` | 同一 NAS 物件。用 UNC server／share、檔名、size、inode、奈秒時間及取樣，排除 client 的 dev 與掛載路徑。無可靠 UNC 別名時不推定跨機。未取樣內容不受全文保證。 |
| `source-v3-sha256` | 本機可攜快取及無可靠 NAS 檔案身分時，使用母素材完整 SHA-256。複製到另一台後驗全文，成功後保存該來源的查驗紀錄供下次開啟；原機與同一實體共享檔有可信識別時可走快速路徑。 |

`source-<key>.json` receipt 只證明來源查驗。元件正式提交點是 `generation-*/cache-meta.json`，根 `meta.json` 為相容索引。並行工作使用獨立世代，合併同來源／相容配置的完成元件。重用、補建、發布及清理均重核來源與根目錄。暫時 I/O 錯誤保留既有內容。背景工作取消後要等 native close、worker 及交接收尾，遲到結果不得再發布。[共享身分測試](../tests/mediaIntakeSharedFileEvidence.test.js) · [跨機快取回歸](../tests/mediaIntakePortableCacheNative.test.js)

**查詢與清理**。`cacheInfo` 無素材直接回空，有素材才以 worker 查 sidecar。檔案尺寸與 checkpoint 描述標為 `verified:false`，查詢失敗另回報。`cacheClearAll(src)` 只委派 `clearSource(src)`，保留活躍讀者／writer，遇忙回報 `incomplete:true`。先在同根隔離目錄，核來源及完整內容再刪，身分不符保留或安全還原。最多 20,000 項、2,048 目錄、48 層，釋放 bytes 只計實際刪除。`cacheRemoved` 依 dev／ino 核銷原登記。[資訊與清理測試](../tests/mediaIntakeCacheInfo.test.js)

**串流**。60 秒仍不可播時以 `STREAM_READINESS_TIMEOUT` 拒絕並等 writer 結束。已回 URL 只代表可讀。背景完成才准下一個 writer。每個 HTTP Range 讀取與 `streamLeaseId` 綁定原根、世代、Proxy 及 sender。釋放 reader、換專案或退出收回對應 HTTP 工作。writer 結束不釋放其他有效 reader。`INGEST_SUPERSEDED` 另核 renderer 本地撤銷狀態。音訊先保留實際 PTS，再對齊影片時鐘、補前置靜音或裁負時間。不能先按 stream 各自歸零。[來源時鐘](../electron/media-source-clock.js)

### 固定畫面與反向音訊快取

`clipFrame` 取已授權來源畫格，`reverseAudio` 接遞增的來源 In／Out 及 stream。PNG／WAV 分放 `clip-frames`／`clip-audio`。`clip-cache-artifact.js` 以 `wx+` 建世代並持有可 seek 的 `fd:`，等 FFmpeg 關閉、核內容／母素材／目錄才發布 `ready`。PNG 核區塊順序、CRC、IDAT 解壓、列長及濾鏡（含 Adam7），檔案及解壓資料各限 1 GiB。舊有效產物可重用，損毀另建世代。[PNG 測試](../tests/clipFrameCache.test.js) · [反向 PCM 測試](../tests/clipAudioCache.test.js)

### 執行進度與終態

所有 Windows 背景子程序使用 `windowsHide:true`。FFmpeg stderr 依 CR／LF 增量解碼，保留跨 chunk 文字與最後一列。每次執行用 `wx` 建獨立 log，receipt 綁檔案與父層身分。成功等記錄 stream `close`，失敗保留本次記錄。記錄寫入失敗不改原生結果，無所有權的同名檔不授權讀取或刪除。

進度分查快取、來源驗證及轉檔。分母未知用 `pct:null`。終態早於 IPC 回覆時，仍保留待交接工作的取消資格。退出先封閉准入，等 probe、direct、intake、PCM／辨識、cache、queue 與截圖收尾，才清本次 `subtool_cache-*`。失敗回報並恢復能安全恢復的 owner。辨識壓縮的作用域也包含 native close 後讀取及清理 MP3。

### 聲量量測

面板量 MIX 取所有來源聲道等權，各 stream 的效果另行量測及保存。來源時間零點只套一次。平衡、重開及交付共用有效報告或相同 fallback。程序失敗、缺欄或格式錯誤不補零。短音訊 `input_i=-inf` 須看實測峰值，≤ −70 dB 保留原音，高於門檻而雙遍不可用時走單遍。面板以 RMS 補值時標示 RMS。

`audio-effect-cache.js` 依母素材／stream／參數保存預聽、波形與量測，讀者持有時保留目錄。重開核對來源與檔案。逐 stream 先 probe 拓撲。正常 Peak 使用 `alimiter`，完全靜音維持 0 dB。True Peak 第二遍的 `measured_*`／offset 必須來自有效量測。`audioNormalizationSourceEvidence` 表示目前 bridge 支援平衡來源證據。[平衡執行](../electron/audio-normalization-runtime.js) · [效果保存](../electron/audio-effect-cache.js)

### 原音電平取樣

快取接管前，mpv 的原音由 `native-audio-meter.js` 唯讀解碼為 48 kHz Float32。每 50 ms 求峰值，renderer 每 100 ms 最多一個請求。多輸入 bus 以相同區間的 signed PCM 逐 sample 乘 gain 後相加，保留相消及疊加。最多 128 聲道、每來源 32 個區間。推子調整可沿用解碼器。換源／定位／速度改變、靜音到無有效輸入、快取接管或一秒無輪詢則停止相應工作。電平不驅動播放時鐘或交付。[原音播放](../tests/nativeAudioMeterPlayback.test.js) · [混音內容](../tests/nativeMixerPlayback.test.js)

### 人聲波形 PCM

`vocalWaveChunk` 只讀已授權母素材，每段最多 36 秒，回 44.1 kHz 雙聲道交錯 Float32。保留來源 PTS 與聲道，尾端少樣本按原時間補零，結果只供分析。以 WebContents／request id 管理。取消、視窗銷毀或 120 秒期限停止程序，退出十秒仍無法確認終止則保留追蹤並回報。[人聲波形執行](../electron/vocal-waveform-runtime.js)

### 交付

`delivery-runner.js` 以凍結快照核權限、測試本次實際 encoder，probe **母素材**後由 `export-plan.js` 生成 argv。交付明確使用 `queued-delivery`，缺 queueDir／jobId／outPath 即拒絕。短編碼能力探針檢實際畫格，光碟另測工具。成品依下列規格驗證。

- **格與聲道**。在絕對交付格網上合成，使用 PTS、半開 In／Out、速度與 offset，VFR 倒放／固定格用實際來源區間。隔行採場格網、補末場再 TFF。H.264／ProRes 先依畫布合成再補邊到 targetW／targetH，最後疊輸出 TC。舊工作只傳 targetH 依畫布比例推寬。各 bus 獨立混音並補到交付片長，保留較長尾音。[時間契約](FPS_時碼一致性.md)
- **權限與覆寫**。main 捕獲使用者所選根的 canonical path、dev／ino，核對來源與目的實體項（含 8.3）。批次以同 sender＋request＋ticket 核發目的預檢收據，已存在目標需完整內容 SHA 與實際同意。入列、probe 後、轉交及發布前重核。變動時保留原目的檔與可復原 stage。舊版缺可信目錄或目的檔證據要由使用者重新選擇，重選目錄不會同時授權覆寫新檔。[目的檔確認](../tests/deliveryConsent.test.js)
- **原生程序**。停止先落盤 stopped journal，再停止 native，直到 runner 結束皆屬 stopping。有 PID 的 error／exit 仍等 close 或受控傳輸收尾。接收最後 IPC 結果才裁定。Windows watchdog 採 detached，父程序被終止後仍處理 disconnect、FFmpeg、stage／lease。正常退出等 completion。補充 bitrate probe 失敗只回空值，不追溯更改已提交結果。
- **字型與路徑**。ASS 用字型內部 family。Windows filtergraph 使用既有兩層跳脫。以畫面核對字型、位置與特殊字元路徑。[技術鐵律](技術架構說明.md#0-鐵律invariants)

| 輸出階段 | 可以進下一步的證據 |
|---|---|
| 保留 | `output-leases/<雜湊>.lock/owner.json` 記 jobId、token、PID、pipe、outPath、目錄與 stage 身分。以 canonical outPath＋token 派生 stage，`wx` 保留。檢查空預留後才啟動 writer。 |
| 封裝與提交 | 核對路徑、原目錄、實際 handle，等編碼、封裝及內容驗證成功。重核取消、stage 與最終檔完整內容後同目錄 rename。只有提交及釋鎖都成功才 done。 |
| 失敗與復原 | 等 writer close，只清身分可證的私有檔。原 pipe／token 優先。peer 消失仍須核登記的兩個 PID 已終止、原根及 stage 身分。舊 lease 證據不足、輸出遭替換、清理失敗或資料未知，保留 stage／lease 與診斷。保留紀錄無法寫入時提示重啟前備份。 |
| 互斥範圍 | 佇列鎖以外，共用鎖保護相同使用者、同一 appData 實體視圖的實體目錄項。不同機器、使用者或舊版不在此保障。OS 外部寫入仍有最後核對與 rename／unlink 的競態。 |

### Encoder

一般 H.264 回報實際 encoder，固定交付按各自規格。分開記錄冷啟動、warm cache 與硬體轉檔時間。

#### Proxy 的 GPU 路徑

`previewPipelineCandidates()` 依同一來源的 probe 與 encoder 選候選，`buildIngestArgs()` 產生實際參數。新建 Proxy 最高 720p、4000 kb/s 目標、6000 kb/s 峰值、最快 preset、無 B 幀、短 GOP。保留來源 PTS 與縮放前的色彩解讀。

| 來源 | 路徑 |
|---|---|
| SDR H.264／HEVC 的 8-bit 4:2:0，或 HEVC Main10 的 10-bit 4:2:0，無旋轉或交錯 | 可用時 CUDA 解碼＋縮放，再 NVENC |
| 其他支援的 SDR YUV（如 ProRes） | CPU 解碼／轉 4:2:0，再上傳 CUDA 縮放、NVENC |
| RGB、full-range、HDR、旋轉／交錯或資訊不足 | 相容色彩／幾何流程，再用實際 encoder |
| QSV、AMF、VideoToolbox、CPU | 相容路徑，不用 CUDA 縮放 |

只有明確硬體／濾鏡相容性錯誤才逐級回退，最後為 libx264。先等舊 writer close、驗來源、用新 generation。已交付串流 URL 後不換輸出，磁碟、權限、毀損或取消應照實失敗。背景 intake 首次讓播放器先讀一秒。串流與重試無此等待。同 encoder 比對 GPU／CPU 的 PTS、GOP、色彩、聲道與實際像素。[Windows 真實 GPU 回歸](../tests/proxyGpuNative.test.js)

#### MOD-FHD 交付規格

| MOD-FHD 項目 | 對應規格 |
|---|---|
| 視訊 | CPU libx264、1920×1080、30000/1001、TFF／MBAFF、High@4.1、7280 kbps CBR |
| 編碼 | GOP 上限 32、2 B、4 refs、CABAC、單 slice、AUD／HRD、一秒 VBV |
| 合成 | 60000/1001 場時刻。隔行來源 bwdif，TC 交織後計數 |
| TS | 7980 kbps、188 bytes、Video/PCR 4131、Audio 4130、PMT 1280、program／TS id 1 |
| 時序 | PAT／PMT 100 ms、PCR 40 ms |
| 音訊 | 單一 AAC-LC Stereo、48 kHz、256 kbps、ADTS／eng。關 PNS，結構核對後設 MPEG-2 ADTS ID |

未設定專案平衡時，最終 Stereo 為 −12 dBTP 上限、非靜音約 −18 LUFS。既有設定不重套，純靜音保留。Carbon 部分參數無等價 x264 設定。使用 [verify-mod-fhd.js](../scripts/acceptance/verify-mod-fhd.js) 查兩場像素、音訊、ADTS、PID、PCR、PAT 及片長。

### 航空 MPG 自動合成

格式為 188-byte MPEG-TS，副檔名 `.mpg`。同一次 FFmpeg 編碼合成，保留原 PTS／DTS 與 AAC priming。舊 raw `.h264`／`.m1v` 工作從交付清單重送。

| 格式 | 視訊與音訊要點 |
|---|---|
| exW | Main@3.0、640×360、正方形像素／16:9、30000/1001p、VBR 500／max 2000 kbps、125000-byte VBV、GOP 15、3 B／2 refs。AAC Stereo 48 kHz／64 kbps |
| DMPES 1.5M | Main@3.0、720×480、SAR 32:27／16:9、30000/1001p、1500 kbps CBR、GOP ≤15、3 B／2 refs。AAC Stereo 48 kHz／128 kbps |
| DMPES 4M | 同上，視訊 4000 kbps CBR |

DMPES 採 16:9／SAR 32:27、NAL HRD CBR。exW 關 HRD、寫逐格 pic timing、AFD 10，停提前 IDR。三者關 deblocking、weighted prediction、B pyramid。末 video PES 加 EOS／EOST。1.5M／4M 排程 VBV 為 130124／347124 bytes。

Transport program 1，PMT 0x3f，Video/PCR 0x30，Audio 0x31。DMPES 1.5M／4M CBR 分別 1855594／4600000 bps，exW VBR 上限 2.5 Mbps。video TB 目標 ≤400／上限 512 bytes。音訊提前約 0.1／0.35 秒（DMPES／exW），PCR 約 50 ms、PAT／PMT 約 90 ms。48 kHz AAC 每 1024 samples 遞增 1920 個 90 kHz ticks。比對 ADTS、AAC bytes、解碼 PCM、排程及影音同步。實際成品另做 TSA6／7 檢測。[封裝器](../electron/airline-transport.js) · [音訊時鐘測試](../tests/airlineAudioClock.test.js)

### DVD／BD ISO 自動製作

| 成品 | 編碼與封裝 |
|---|---|
| DVD | MPEG-2 720×480 TFF／29.97，dvdauthor VIDEO_TS、mkisofs UDF 1.02，標籤 DVD |
| BD | AVC High@4.1，23.976／24 為 1080p、25／29.97 為 1080i。tsMuxeR UDF 2.50，標籤 BD |

`disc-encoding.js` 依真實片長扣 AC-3 多串流、64 MiB 導覽與 8% 封裝預留。BD 選不低於來源且最高 29.97 的可用格率。字幕先依顯示比例燒錄再縮儲存尺寸。兩者均無選單、首播 title 1。驗 UDF anchor、logical volume、tag checksum、descriptor CRC、標籤、容量，另解碼查聲道。

Windows 在 lease 專屬目錄工作，個別短 junction 協助原生工具處理長路徑，BD 必須仍寫原先預留的同一 stage。建立、啟動、重啟與清理均核目錄、junction 與 stage 身分，只移除驗過的連結，不沿連結刪除目的地。TEMP 改變或原身分不明時保留 lease。stdout／stderr 讀錯要保留首個錯誤並等 child close。工具來源、SHA、DLL 與授權見 [disc-tools.json](../electron/disc-tools.json)。[真實 ISO 測試](../tests/discAuthoring.test.js) · [取消與復原](../tests/discWatchdog.test.js)

## 5. mpv 嵌入整合（Windows）

Windows x64 需在 `electron/mpv/` 放 `mpv.exe` 與 `d3dcompiler_43.dll`。`mpv.detect()` 可查工具與當前實例的 logPath。每次 launch 使用獨立 pipe／log／ASS。舊 close、錯誤不得清理新實例。以 idle／pause 啟動，接好 pipe 再 loadfile，確認來源、playback-restart 與有限 time-pos 才 ready，全程保留暫停。

### 精準呈現

- 每次 launch／loadfile 建立不同來源 session，以 playlist entry、client、路徑與世代配對。duration 通知只觸發重查，舊觀察者或延遲讀數失去資格。time-pos、pause、core-idle、paused-for-cache、seeking 綁當前來源。
- `mpv:present` 只留最新請求。暫停定位核命令 ACK 後的命中 time-pos。播放／擷取另核相應 restart。逐格用 time-pos setter。restart 無來源／請求 ID，最後用真實像素驗證。起播就緒與緩衝恢復各有證據，單一 ACK 或 URL 不足。
- 原生與 renderer 交界只用**影片來源秒數**。例如影片比容器晚 0.5 秒，來源 2.8 秒對應容器 3.3 秒。已歸零的 Proxy 不再加偏移。慢速/VFR 素材用 frameTarget／frameStart／frameDuration 的實際區間。[FPS 契約](FPS_時碼一致性.md) · [換源回歸](../tests/mpvSourceTransition.test.js)

### 截圖輸出

`withPresentedFrame()` 凍結時間、FPS 與圖片計畫，等同格呈現，持有至擷取回覆與像素讀入。新 seek／reset／換源使舊結果失效。mpv 只寫自己私有 temp 的影像，回傳已驗身分的畫格 bytes。

正式 JPEG 由 `screenshot-output.js` 以 `wx` 保留下一個 Shot 編號，write／release 須附相同路徑與隨機 token。暫存同步關閉後核原空檔及完整內容，以 exclusive hardlink 發布，不支援時用 wx 複製。失敗只清同次仍持有的 reservation／暫存。退出等已准入擷取／保存收尾。[截圖輸出測試](../tests/screenshotOutput.test.js)

### Guide 與互動

mpv 是 OS 子視窗。Renderer 從 computed style 與實際矩形收集遮擋，`setNativeViewport()` 同時更新 bounds、visible、occluders。host／guide 同步裁切。`BrowserWindow.setShape()` 接視窗內部 DIP，由 CSS 按 page zoom 轉換。整個覆蓋要 hide（空 shape 會還原矩形）。縮放／restore／開關浮窗需重算。透明 guide 維持 ignoreMouseEvents／forward，拖曳與 hover 由主 renderer 負責。實測作業系統合成像素及滑鼠穿透。[原生疊層驗收](開發與驗證.md#3-真機驗證cdp)

### macOS

Apple Silicon 測試包回報 mpv 不支援。使用 ffmpeg ingest／Proxy、HTML 或 WebCodecs。驗收使用實體 Mac。

## 6. 匯出佇列

`export-queue.js` 的 `JOB_STATUS`／`TRANSITIONS` 管狀態。queued → running → done／failed。停止先到 stopping，再依實際收尾裁定 stopped／done／failed。missing-source 須重連才可再入列。暫停排程只擋下一份。關主視窗且仍有工作時由監控接手，真正退出等 owner 收尾。[每份交付一個程序](adr/0001-每份交付各自一個-ffmpeg-程序.md)

- **工作快照**。保存當次 payload、ASS、audioPlan、projectBusOrder、目錄與覆寫證據。歷史音軌摘要從凍結資料讀，舊資料標示未記錄。不拿目前配線補猜。編輯 queued 工作要保留草稿與焦點，其他工作仍刷新。
- **重試**。`retryWithOutputDirectory` 由 main 選回原實體目錄，核 job、attempt、來源、狀態與權限後才保存。目的檔證據不足另用 `retryWithOutputConfirmation` 重新確認。改格式推導的不同檔名已存在時拒絕。取消或舊 attempt 回覆保留原工作。新授權不會補足舊 lease 的 stage 身分。
- **重啟**。先查 owner、原生 PID、journal／lease，再清已確認屬於本工作的私有半成品。無法核對或仍在收尾就保留。停止意圖須先持久化，失敗則保持 running。stage／釋鎖失敗落盤為 failed。安全退出取消後重新派發合格 queued 工作。
- **持久資料**。`queue-store.js` 分開 live state、終態 journal 與 `history.json`。只有 ENOENT 代表未建立。其他 I/O 錯誤保留。JSON／schema 毀損先完整備份 `.corrupt-<uuid>`。寫回失敗保留原檔、待提交紀錄與錯誤。歷史只授予精確成品定位。[復原測試](../tests/exportQueueRecovery.test.js) · [佇列交易測試](../tests/exportQueueTransaction.test.js)

## 7. 打包與發布

核對 [package.json](../package.json) 的平台 `files`、`asarUnpack` 與 `extraResources`。兩平台皆需 shared。standalone watchdog、lease、artifact 及格式相依須可在 ASAR 外執行。字型在 extraResources。Windows 收 §4／§5 工具、光碟 manifest 與授權。NSIS 為 perMachine。不要在 repo 根執行 `asar extract-file`。核對同一份安裝器、ASAR 來源及原生能力的順序見[正式發版與 Mac 分流](開發與驗證.md#2-建置與發版流程)。

## 8. 排查

先記問題時碼、來源、job／session／request、main log、renderer console，再用實際內容判斷。

| 現象 | 先查／怎麼驗 |
|---|---|
| 啟動或原生工具失敗 | 查 `status()`、`mpv.detect()`、平台、工具路徑與實際 ASAR／unpacked 內容。主程序啟動錯誤另查 shared 是否封裝。 |
| 波形重做、重開後無個別聲道 | 查配方、原 stream／channel、`checkpoint.json` 與 PCM SHA、續算 overlap。對照讀取 bytes、FFmpeg 次數及聲道峰值。warm wave 已有但仍重產時查 duration、來源證據與 argv 的映射。 |
| NAS 慢或快取不可寫 | 查 `sourceContent.format`、receipt、processedBytes、worker／main 分工與 PCM 背壓。分辨母素材全文驗證、WAV 驗證、暫時 I/O 錯誤及唯讀缺件。 |
| 換專案仍跑舊 Proxy、串流黑畫面 | 查 session／request 取消、`INGEST_SUPERSEDED`、writer close、readiness、HTTP Range／lease 與實際 presenter。 |
| 逐格不動、跳轉疊音 | 核來源格區間、pending、client、time-pos、mute ACK、ready 及緩衝回覆。看實際畫格及 PCM。[FPS 排查](FPS_時碼一致性.md) |
| 字幕、疊層或音訊不符 | 字幕查 effStyle、PlayResY、內部 family、跳脫。拖曳查 guide 讓位與 renderer layer。聲音沿來源→bus→交付比對 PCM 及尾音。 |
| 專案／字幕輸出、備份遺留 tmp | 查原目錄、write／sync／close 結果、關檔後快照及完整 SHA。保留衝突與不明歸屬資料。 |
| 交付路徑無法重試、關閉後留 stage | 核原目錄與覆寫證據、owner.json、PID／pipe、log、native close、journal。身分不足時保留現場，可改檔名重送。[使用說明](使用說明.md#匯出序列) |
| 本機資源或按鈕無反應 | 查 token、Range、CORS、sender 與實際 renderer handler。Electron 輸入使用 `promptModal()`。 |

工具用法及量測界限見[問題回報](開發與驗證.md#5-問題回報)。
