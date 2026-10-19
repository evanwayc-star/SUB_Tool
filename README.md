# SUB Tool

把字幕、影片、圖片與音訊放在同一個精準時間軸上，完成打點、校稿、混音與成品交付。

**[下載 Windows 安裝版](https://github.com/evanwayc-star/SUB_Tool/releases/latest)** · [開始使用](docs/使用說明.md) · [版本紀錄](docs/版本變更紀錄.md)

![SUB Tool 多軌字幕工作區](docs/images/workspace-overview.png)

*畫面使用示範素材與字幕；功能說明依目前原始碼維護，安裝包內容以 Release 紀錄為準。*

## 從素材到成品

1. **匯入**：拖入影音、圖片或字幕，建立並儲存 `.subtool` 專案。
2. **打點與編輯**：左右鍵逐格，J／K／L 穿梭，I／O 設定字幕時間；多軌排列並調整逐句樣式。
3. **校稿**：搜尋、字幕檢查與比較，或以語音辨識與逐行文本匹配建立初稿。
4. **交付**：另存字幕檔，或將影片／音訊工作送入背景匯出佇列。

完整步驟與快捷鍵見[使用說明](docs/使用說明.md)。

## 保護已有的編輯

- 刪除字幕、合併、刪軌、覆蓋匯入與其他會移除既有字幕的操作，先列出數量再確認；取消保留原內容。
- 影片、音訊與字幕軌可分別鎖定；鎖定軌仍可定位播放點，內容維持唯讀。
- 支援多視訊軌、圖片疊層、修剪、速度、反轉、凍結畫面與淡入淡出。
- 專案儲存、Undo／Redo 與背景工作保留各自的工作區所有權，避免晚到結果覆蓋較新的編輯。

## 播放與音訊

時間軸支援精確格率與 DF／NDF 時碼。HTML、mpv 與 WebCodecs 依播放情境提供預覽；字幕樣式由同一套規則供預覽與燒錄使用。

Windows 桌面版可先播放母素材，再於背景建立 Proxy 與音訊快取。運算期間仍能切換聲音；狀態列可取消處理，換專案會停止舊工作。Proxy 供預覽使用，正式交付讀取母素材。

來源聲道、專案音訊軌與交付聲道可分別設定。混音器提供靜音、獨奏與音量控制，配線視窗決定聲道去向；操作見[使用說明](docs/使用說明.md)。

## 語音辨識與文本匹配

![語音辨識視窗](docs/images/speech-recognition.png)

語音辨識由聲音產生文字與時間；文本匹配保留已校對的逐行原稿，分析每行的時間。可選本機 Whisper，或使用 Groq、OpenAI、Azure Speech、Google Gemini、ElevenLabs 等雲端引擎。雲端功能需要對應服務的設定與存取權；辨識結果仍應校對。

![逐行原稿的文本匹配](docs/images/text-alignment.png)

## 多份交付，一次送出

![背景匯出佇列，畫面為示範工作](docs/images/readme-export-queue.png)

內建九種交付規格：ProRes422HQ-MOV、H264-MP4、WAV、DVD-ISO、BD-ISO、MOD-FHD，以及航空 DMPES 1.5M／4M 與 exW。字幕檔可另行匯出。

每份工作使用送出當下的快照，可查看進度、停止、重試與調整佇列順序。格式限制、聲道編組與燒入字幕設定見[影片與音訊交付](docs/使用說明.md#影片與音訊交付)。

## 平台與安裝

| 平台 | 可用方式 |
|---|---|
| Windows 10／11 x64 | 正式安裝版；內含 ffmpeg、ffprobe 與 mpv，為大檔、多聲道與正式交付的主要驗收平台 |
| Apple Silicon | 可建置本機 unsigned arm64 DMG／ZIP；正式發佈尚需簽署、公證與實體 Mac 驗收 |
| 網頁版 | 適合瀏覽器可直接解碼的素材；桌面原生能力與格式支援不同 |

Windows 使用者從 [Releases](https://github.com/evanwayc-star/SUB_Tool/releases/latest) 下載 Setup、完成安裝後即可開啟。自備素材保存在自己的位置，專案檔請與素材一起備份。

## 從原始碼執行

```bash
npm ci
npm run electron
```

瀏覽器開發執行 `npm run dev`；Electron 開發模式另執行 `npm run electron:dev`。環境、原生工具與驗證流程見[開發與驗證](docs/開發與驗證.md)。

## 文件導覽

| 你要做的事 | 閱讀位置 |
|---|---|
| 安裝、打點、校稿、混音、交付 | [使用說明](docs/使用說明.md) |
| 開發、測試、真機驗收、打包發版 | [開發與驗證](docs/開發與驗證.md) |
| 修改模組、樣式或資料流 | [技術架構說明](docs/技術架構說明.md) |
| 維護 IPC、檔案權限、ffmpeg、mpv、佇列 | [Electron 維護手冊](docs/Electron_維護手冊.md) |
| 修改 FPS、時碼、seek、逐格或 presenter | [FPS／時碼一致性](docs/FPS_時碼一致性.md) |
| 確認詞義與既有決策 | [領域詞彙表](CONTEXT.md)、[架構決策](docs/adr/) |
| 共用 renderer 與主行程的規則 | [shared 加入條件](shared/README.md) |
| 查歷史原因與驗證證據 | [版本變更紀錄](docs/版本變更紀錄.md) |
| 查有日期與來源的技術評估 | [語音辨識研究](docs/research/語音辨識引擎改善評估.md)、[人聲波形研究](docs/research/人聲波形模型研究.md) |
| 交接 AI 維護工作 | [AGENTS.md](AGENTS.md)、[領域文件設定](docs/agents/domain.md)、[Issue tracker](docs/agents/issue-tracker.md)、[Triage 標籤](docs/agents/triage-labels.md) |

## 原始碼位置

`src/` 放 renderer，`electron/` 放桌面與原生整合，`shared/` 放兩行程共用純規則。測試在 `tests/`，驗收與發版工具在 `scripts/`，自備字型在 `font/`。放置與命名細則以[開發文件 §6](docs/開發與驗證.md#6-目錄結構與命名)為準。

授權：ISC。
