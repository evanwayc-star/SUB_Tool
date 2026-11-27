# FPS／時碼一致性

修改時碼、seek、逐格、倒帶、播放點或 presenter 前讀 §2。查程式用 `git grep -n FPS-SYNC -- src`。定位成功以[呈現生命週期](#3-呈現生命週期)的畫格與聲音證據判定。

## 1. 名詞

| 讀數 | 座標與用途 |
|---|---|
| 牆鐘／時碼 | 牆鐘量真實經過時間；`HH:MM:SS:FF` 標記第幾格，DF 用分號。29.97 NDF 每小時約與牆鐘差 3.6 秒；DF 跳過標籤，仍保留每張畫格 |
| 時間軸／來源／播放器 | 字幕、播放點、片段、備註與交付共用專案秒數。來源從影片第零秒算起。播放器回報的容器秒數依來源有偏移 |
| 格網／目標／已呈現位置 | 第 N 格位於 `N / exactFps`。定位目標可提早投影到 UI；已呈現位置須由目前可見 presenter 的畫格證實 |

## 2. 八條不變量

### I1. FPS 來自實測，不依檔名

- 桌面讀 ffprobe 的 `info.video.fps`，網頁量畫格 timestamp。`state.js` 的 `FPS_SET`／`snapFps()` 提供 23.976、24、25、29.97、30；交付清單另見 `shared/delivery-frame-rate.cjs`。原檔名可同時含 24FPS 與 30P。保留偵測小數再比較。
- 首支素材可初始化新專案格網，重開／重連僅更新來源 metadata。每次背景 probe 回覆都核對格網 revision，使用者即使重選同值也撤銷初始化資格。
- NTSC 用 `24000/1001`、`30000/1001`、`60000/1001`。`getExactFps()` 容差 0.01，必須小於 0.024；過去 0.05 會把 24 認作 23.976。

### I2. 時間軸位置轉時碼只有 encoreParts()

播放器、字幕列表、時間軸尺與監看 TC 透過 `encoreParts()`／`secToEncore()` 產生標籤。佇列片長是例外：`queue.html` 從凍結工作 duration／fps 與 preload 共用精確格率，將整數格換為 NDF 片長。與 `secToEncore(duration, fps)` 的契約須涵蓋六小時 NTSC。

### I3. 影格格網只有 snapTimeToFrame()

| 寫入點 | 格網規則 |
|---|---|
| 定位、暫停、拖曳與逐格 | 統一 `snapTimeToFrame()`。DF 只影響標籤 |
| 建立／載入／改 FPS | `snapCueToFrames()` 先正規化端點，正片長至少一格，再建立 History／存檔基準。保留 `timed:false` |
| 播放點單格 OCR | 喚出時凍結播放點，確認後從該格算兩秒，再將終點吸附專案格網。25 fps 跨 50 格，29.97 fps 跨 60 格 |
| 批次時長 | 下限向上、鄰句上限向下轉合法格點，再限制終點。非整格鄰句容不下一格就保留原句 |
| 字幕 FPS 轉換 | 預覽與確認都乘 `getExactFps(from) / getExactFps(to)`，再吸附目的格網。以顯示小數計算可讓長片偏一格 |
| ASS | `secToASS()` 用原秒數轉百分秒。自產 metadata 保留精確 frame，舊檔相容見 [ADR-0002](adr/0002-自產-ass-無損往返.md) |

### I4. 靜止讀數同源於 Media.displayTime()

#### UI 權威與實際呈現

`Media.displayTime()` 是播放器、seek bar、播放點、備註與監看 TC 的共同讀數。暫停取 transport 已吸附的權威值，播放取換回時間軸域的時鐘。`tcCur` 與 `seekBar` 同一 rAF 更新，In／Out 在按鍵當下取值。

`Media.seek()` 先投影目標以回應操作；截圖、定位完成與起播須另等 `presentedTime()` 或本次呈現請求的成功結果。

#### 各 presenter 的完成證據

| 可見 presenter | 本次請求的有效證據 |
|---|---|
| HTML video | `requestVideoFrameCallback()` 回傳的 `mediaTime`。暫停在同一格可重用同來源、同位置的呈現證據，須等 `seeking` 結束且 `readyState >= 2` 才可讀取像素 |
| mpv 播放中定位 | 命中目標的 `time-pos` 與配對的 `playback-restart` |
| mpv 暫停定位 | 命令 ACK 加目標 `time-pos`；同格無新事件時主動查詢 |
| WebCodecs | 全部可見影片與圖片完成繪製。各影片提供自己的實際來源 timestamp |

等待時如換 presenter，改由目前可見者作證。圖片須繪製完成，無須影片 timestamp。

#### 來源畫格區間與慢速播放

先決定時間軸容差，再由同片段映射成來源容差。慢播時多個專案格可共用同一來源格。`presentationSamples()` 套 MP4 edit list，以相鄰呈現 PTS 得出區間。WebCodecs 用實際 timestamp 加索引時長，HTML／mpv 從 `decode/source-frame-index.js` 取得；無索引僅採實際 PTS 容差。

來源 `[start, end)` 反映到倒播時間軸為 `(start, end]`，裁切尾端第一格另保留片段起點。`fadeAlphaAtTimeline()` 僅吸收 offset 相減約一個 ULP 的負誤差。解碼順序 duration、平均 FPS、未來預取格都不能證實目標已在畫面上。

#### 容器起點與來源原點

`shared/media-source-clock.cjs` 提供原點換算。FFmpeg／mpv 容器相對秒數用 `timestampOffset`，HTML／WebCodecs 的絕對 PTS 用 `presentationTimestampOffset`。每個來源 URL 各自保存 seek、讀數、畫格 callback 與 duration 的映射；已歸零的 Proxy／對齊音訊用零偏移。

例：容器從 5 秒、影片從 5.5 秒開始，來源 2.8 秒對應 HTML 8.3 秒、mpv 3.3 秒。以 0／5 秒起點的真實 MKV／MOV 比對像素、回報與片長。

File 的片長／原點共用有界索引。MP4／MOV 依 MP4Box box 位置跳至 moov 並保留 sample 位址；WebM 讀 EBML 與首批 block。無有限片長或 edit list 不支援時走既有退路。

#### PCM 的獨立解碼原點

`AudioEngine.decodeSourceAudioData()`／`normalizeSourceAudioBuffer()` 依各 stream 的解碼原點換算整數 sample；裁去影片前音訊或補前導靜音，供波形、辨識與反向聲音使用。已對齊 buffer／Mono 副本保留標記。AAC active edit 已裁的樣本、Opus pre-skip 已消耗的部分各只處理一次；Opus PCM 原點獨立於 HTML block／CodecDelay。

連續波形用 `round(duration * 4000)` 個 sample，每 40 個取 min/max。續算以接點實際 PCM 驗 resampler 相位與權重，波形桶獨立於專案格網。[媒體 intake](Electron_維護手冊.md#媒體-intake)

#### MOV 延後片長與定位所有權

HTML 初期可能低估 MOV 片長。保留被截斷的目標，僅在可達範圍擴大時重送，直到實際畫格 callback 命中。新來源、transport 或取消撤銷重試，逾時判失敗。原音／overlap voice／scrub 共用定位入口，scrub 從就緒才計時；網頁固定幀經 `presentElement()` 再取像素。

#### 微秒精度與裁切末格

CTS 與 edit offset 相加後才取整數微秒。`sourceFrameTargetUs()` 供 HTML／WebCodecs 共用，預取與繪製用同一目標；精確 PTS 屬於從該點開始的畫格，含反向。半開 Out 上限取嚴格小於 Out 的最大整數微秒，只吸收浮點 ULP。來源 30 FPS、專案 25 FPS 裁到 1.04 秒時，末格為 1.033333 秒；固定扣 1/120 會跳過它。

### I5. 逐格以 displayTime() 為基準

`stepFrame()`／`nudge()` 以整數格計算 `(round(displayTime * exactFps) + direction) / exactFps`，交 `Media.seek()`。快速輸入累積新目標，舊畫格不可倒寫。一般 seek 容差 1.5 格，逐格 0.45 格。mpv 用 `time-pos` setter，長按沿逐格節流，單按才附短 scrub。

時碼欄位上下鍵走 `time.js`。29.97 DF 的 `00:00:59;29` 下一格為 `00:01:00;02`；59.94 DF 跳至 `;04`，每第十個整分鐘由 `;00` 起。增減時／分／秒遇不存在的 DF 標籤，取該秒第一個有效格。

### I6. 原始播放器時間不可覆寫暫停權威值

mpv 暫停仍會送 `time-pos`。`TimelineTransport.observeSourceTime()` 對差小於 4 格的沉降抖動保留暫停位置，明顯跳轉吸附後才提交。載入零點、間隙、純音訊或換來源依各自時鐘與資格。已載妥來源可由較新且已證明完成的定位接手，無須等被 mpv 合併的中間事件。

### I7. 片段邊界永遠是時間軸時間

offset、切割、軌上跳轉、字幕、備註及交付都用時間軸秒數。影片／外音共用 `sequence-time.js`；解除影音保留來源 In／Out、offset、速度、反轉。辨識結果映回時間軸，反轉後按升冪寫字幕，用工作凍結格網。[映射公式](技術架構說明.md#05-時間域外部是時間軸時間播放器是來源時間)

- 重連量到較長片長只更新 runtime 證據；使用者實際延長／重設超出原 `dur` 才提交持久長度與 History。取消、Undo／Redo、重設工作區與換源須保留或撤回各自證據。較短來源仍受其實際範圍限制。
- 固定畫面先 `Seq.toSource()` 再限制半開 Out／EOF，避免變速或反轉選錯格。無選取的字幕導航先找下一句，找不到保持原位；提前五格也要先找到目標。

### I8. 監看 TC 與燒入 TC 分工

| 位置 | TC 的依據 |
|---|---|
| 監看 | `Media.displayTime()` 與專案 FPS／DF |
| 影片交付 | 凍結 `timelineStart` 與該列輸出 FPS。格率預設依專案，可逐列覆寫。僅 29.97／59.94 可用 DF |
| WAV | 無畫面及燒入 TC |

改交付 FPS 保留片段、字幕、音訊的秒數。MKV 粗時基可使 23.976 素材隔幾格重複／跳格。依 probe 的 `time_base`／`r_frame_rate`，距名義格點最多半個來源 tick 時才補償，最多 0.5 ms；首個解碼格留原 PTS，後格不得更早。先補償再裁切／變速／反轉，保留 VFR 缺口與固定畫面的實際 PTS 選格。以 `exportCadenceNative.test.js` 逐格比較 MOV／MKV 相同像素。

## 3. 呈現生命週期

1. **定位**。Media 吸附時間軸目標，在同步通知與定位外音前停止舊 element、buffer、clone。`media-presentation-core.js` 最多一個 in-flight 加最新 pending；新 seek、reset 或換源撤銷過期請求，等待期間仍可改 play／pause。
2. **呈現**。由 session 暫停 presenter，映射來源，等目前可見畫格符合 [I4](#i4-靜止讀數同源於-mediadisplaytime) 才提交呈現位置。裸 ACK、逾時、非空但過期的 frame 都無法完成。
3. **整組起播**。固定同次來源／時間軸目標，更新作用中片段的配線；`prepareElements().ready` 等齊全部聲道與 overlap voice。依最新意圖請 presenter 起播，確認 readiness、重取有效時鐘，再 commit 全組一次並記錄外音活動。晚回覆跨片段／容差，最多按同一實際時鐘重備一次。等待、失敗或取消時阻擋背景聲道自啟。[聲音交接](技術架構說明.md#播放聲音的唯一-owner)
4. **跨片段／片尾**。同一 tick 先套疊合配線，再起播原音與外音。tick 與 ended 共用轉場。進入間隙或外音尾段先停舊載體，再依片段終點接虛擬時鐘與有效外音；同步重入時新意圖優先。未裁切快徑只容許來源片長與 Out 的 ULP 誤差，裁掉一格也要在 Out 轉場。
5. **換源／失連**。mpv 的 `end-file` 配對 playlist entry 及來源 session，相同路徑重載仍是新 session；載入回覆前到達的合法終止延至交接。只有已確認的 adapter 與路徑相符才可跳過重載。當前來源真失連時停止影片及等待工作，收尾 follower 並提示；由間隙或純音訊虛擬時鐘接手後，舊 HTML ended／mpv 失連不可停止它。

倒帶節流及切回母素材的決策見 [ADR-0003](adr/0003-倒帶以實際呈現畫格節流.md)。

## 4. 關鍵 owner

| 模組 | 唯一責任或介面 |
|---|---|
| `time.js` | 精確 FPS、DF／NDF、標籤及 frame snap |
| `shared/delivery-frame-rate.cjs` | 精確 NTSC 有理數與交付格率對照 |
| `state.js` | 專案 FPS／DF 及明確格網變更的 revision |
| `sequence-time.js`、`sequence.js` | 影片及外音的速度／反轉時間映射與片段查詢 |
| `clip-model.js` | 片段編輯交易及固定畫面預設來源格的 Out／EOF 限制 |
| `subtitle-model.js` | 字幕端點的格網與至少一格准入 |
| `tcparse.js` | 時碼輸入、分量上下鍵及組字按鍵保護 |
| `subio.js` | FPS 轉換與批次時長，使用模型的合法上下限 |
| `media-presentation-core.js` | 請求、取消、pending、播放意圖及畫格 hold |
| `media.js` | `displayTime()`、presenter 選擇、來源切換與音訊生命週期 |
| `media-playback-runtime.js` | Media 內部片段接續、配線及音訊起播活動的共同 owner |
| `audio-engine.js`、`audio-placement-playback.js` | 固定來源／時間軸目標的整組聲道準備、commit、取消及獨立 overlap voice |
| `media-player-adapter.js` | HTML／mpv 操作、來源時鐘及延後定位 |
| `transport-controller.js` | 逐格、JKL、倒帶 session、字幕導航及按鍵當下的 In／Out |
| `timeline-interaction-engine.js` | jump／drag 意圖；不私建播放器時鐘 |
| `media-loader.js` | 載入與 mpv listener 的工作資格 |
| `media.js` 的 `observeMpvEvent()` | mpv 來源讀數、暫停抖動與播放狀態裁定 |
| `decode/demux.js`、`decode/source-frame-index.js` | 實際 CTS 呈現區間及有界索引 |
| `decode/player.js` | 各可見層畫格證據及完整 Canvas 發布 |
| `timeline-renderer.js` | 時間軸刻度與播放點的同源顯示 |
| `delivery-list.js`、`delivery-job.js` | 凍結起點、逐列格率及交付範圍 |
| `electron/main.js`、`electron/queue-preload.js`、`electron/queue.html` | 佇列片長的精確格率純值 adapter |
| `electron/export-plan.js` | 輸出有理數格率與轉碼；H264-MP4 不猜測來源 copy 資格 |

## 5. 常見失敗

### 時間軸刻度與播放器差幾秒

檢查是否有人以牆鐘秒數自行拼時碼，或先將 23.976／29.97 四捨五入。標籤回到 `encoreParts()`，格率回到共用有理數。

### 右鍵跳兩格、左鍵不動

檢查逐格基準是否來自原始播放器浮點時間，或舊 request 是否回寫了較新的目標。應從 `displayTime()` 的整數格推進。

### 按左右鍵但時間點沒有變

依序核對單格容差、mpv `time-pos` setter、最新 pending 的提交資格、重複輸入的目標累積，以及 presenter 是否只有 IPC ack 而缺畫格證據。

### seek 後立刻播放看到舊畫面或音訊先跑

檢查 session 的最新播放意圖、`playback-restart` 配對及背景音訊起播資格。等待期間的 pause ack 不得清掉較新的 play，背景來源也不得提前起播。

### Proxy 跳轉後短暫回音，原地暫停再播恢復

先核對同源 native mute ACK，再延遲其中一軌的就緒回覆，比對各聲道／overlap voice 實際非零 PCM、相對位置與同組起播次數。若同一聲道被反覆拉回，依序量 mpv 命令 ACK、核心 readiness、來源時鐘進展；buffering 時提早啟動 follower 會觸發 drift correction。原地重播正常仍須測長距離 seek／取消。

### 純字幕專案播放點變了，預覽沒變

沒有影片時仍須發布統一 seeked／playhead invalidation；消費端依 `displayTime()` 重繪，不能依是否存在 HTML video／mpv 決定要不要更新。

## 6. 驗證

時間變更先鎖定相關契約測試，再依[開發與驗證](開發與驗證.md)執行真機播放驗收；本文件不另維護啟動及 CDP 指令。

| 要證明的內容 | 主要測試 |
|---|---|
| 有理數、DF、格網及長片時碼 | `time.test.js` |
| 最新呈現、取消與播放意圖 | `mediaPresentationCore.test.js`、`mediaPresentationRuntime.test.js` |
| 時間域、逐格與 JKL | `timelineTransport.test.js`、`transportController.test.js` |
| HTML／mpv 來源原點與真實像素 | `webSourceClock.test.js`、`desktopAudioSourceClock.test.js` |
| PCM 原點及實際聲音位置 | `decodedSourceAudioClock.test.js`、`decodedSourceAudioClockNative.test.js` |
| seek／背景起播及聲音數量 | `mediaPlacementAudio.test.js`、`audioScrubOwnership.test.js` |
| Proxy 聲道跳轉回音、共同就緒與取消 | `proxyAudioHandoffEcho.test.js`、`audioElementStartReadiness.test.js` |
| 波形 sample 原點、續算接縫與串流 Proxy 沿用 PCM | `continuousSourceWaveformNative.test.js` |

保留三支真實素材矩陣：`V_MAMAMOO_FTR_24fps_51FM.mov`、`V_拼桌_FTR_24FPS_51FM+20FM_30P.mxf`、`V_心機特務_FTR.mp4`。核對中尾段長距離 seek、單格及快速交替、長按、seek 後立即 play／pause、JKL 多倍率、倒帶回母素材，以及畫面、播放點與監看 TC 的持續漂移。

驗收須量測實際畫格與 PCM／voice，不能只看 Promise、檔案存在或 TC 字串相同。新增時間邊界時同步補 `FPS-SYNC`、介面測試及本文件責任表。
