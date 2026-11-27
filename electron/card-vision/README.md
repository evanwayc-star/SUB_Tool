# 畫面文字辨識原生引擎

核心移植自使用者提供的 `kvariety-card-vision` Rust v3 實作：`video.rs`、`llm.rs`、`stitcher.rs`、`pipeline.rs`，保留五區追蹤、自適應抽幀、雲端視覺辨識、疑難複檢、字形校對及字卡／對白分類。GPUI 與原工具憑證儲存未納入。

建置與使用入口見 [開發與驗證](../../docs/開發與驗證.md)及[使用說明](../../docs/使用說明.md)。引擎以來源秒數回報結果；專案時間映射與 FPS 吸附由 renderer 負責。

## 行程協定

每個行程只接受一個工作。stdin 第一行為 JSON：`path`、`start`、`end`、`samplesPerSecond`、`sourceLang`、`provider`、`model`、`smartAccuracy`、`frameWidth`、`apiKey`、`cacheDir`、`ffmpegPath`、`ffprobePath`。路徑皆由 Electron main 決定；憑證只在記憶體使用，不進 argv、快取或日誌。

stdout 為 NDJSON：

- `progress`：`progress`、`message`。
- `checkpoint`：`cues`、`processedEnd`。只包含從第一個視窗連續完成的範圍；未完成視窗前的重疊區保留待續。可供取消時保留部分結果。
- `result`：`cues`、`processedEnd`。完整完成後回傳，cue 保留 `kind` 與 `slot`。
- `error`：已遮罩憑證的 `message`，行程退出碼 1。

stdin 後續 `{"type":"cancel"}` 設定取消旗標；EOF 不代表取消。Electron main 另負責停止整個程序樹，避免等待正在進行的網路請求。API 已完成視窗各自持久快取；強制中止時正在進行的請求可能已計費但尚未寫入快取。

快取以來源完整路徑、檔案大小、修改時間、範圍與辨識設定識別。部分結果尚未完成全片複檢與校字。追蹤步進不代表實測辨識或時間邊界誤差。

## 品質策略與快取

預設模型、解析度、費用與人工校對要求見[辨識畫面文字](../../docs/使用說明.md#辨識畫面文字)。智慧精準模式保留原方案的偵測門檻，每對相鄰取樣錨點仍只補入最強的合格短閃畫格，但移除全片補幀比例及 360 張上限。所有已判定疑難的視窗均送複檢，不再限制為全片的 30% 或 45 個視窗。重疊區文字互相矛盾時，兩側都複檢，且不把另一側的矛盾文字當提示；初掃即使已用旗艦模型，寬度低於 1440 仍可進行高解析複檢。

每次工作都重新規劃取樣、選擇疑難視窗及縫合字幕，不直接回傳舊成品。來源與追蹤設定相符時，可沿用本機邊緣追蹤；視覺快取另核對模型、提示版本、畫面規格及取樣數構成的識別，再逐視窗比對範圍與實際取樣時間。取樣改變的視窗須重新辨識，新判定疑難而缺少複檢快取的視窗須補跑。原文校字只在校字版本、模型及輸入文字／上下文相同時沿用快取。因此移除補幀或複檢上限後，舊案可能增加 API 請求；不會為了沿用舊結果而略過新增的品質步驟。

複檢子目錄另帶 `review-v2` 政策版本，避免沿用曾將另一窗矛盾文字當提示的舊複檢結果。此次不變更初掃提示詞，也不刪除任何舊快取；相符的初掃與本機追蹤仍可沿用，舊政策下的疑難複檢則會重新呼叫 API。

## 驗證

`cargo test --manifest-path electron/card-vision/Cargo.toml --locked` 包含字卡合併、重疊保留、連續 checkpoint 及原生 FFmpeg 像素驗證。原生測試需要專案的 FFmpeg／FFprobe；會比較零起點與容器 5 秒、影片 5.5 秒的來源畫格，亦檢查提前 EOF 與損壞來源。測試不呼叫雲端 API。

另有需外部素材的 `offline_v3_fixture` 驗收：設定 `SUBTOOL_CARD_VISION_FIXTURE` 為原方案 `test_v3_sample` 成品目錄、`SUBTOOL_CARD_VISION_VIDEO` 為該份原始影片，執行 `cargo test --manifest-path electron/card-vision/Cargo.toml --locked offline_v3_fixture -- --ignored --nocapture`。測試先比對影片大小與修改時間，重算本機追蹤，再逐項核對取樣時間；只把相符的 VLM／複檢／校字快取複製到新建的系統暫存目錄。完整流程的輸出 JSON 必須與參考相同，另讀回 SRT 並留下三張來源畫面與 `offline-verification.json`。所有測試編譯均拒絕 HTTP，因此任何快取缺漏會讓驗收失敗，不會改呼叫雲端。

取消補幀上限後，75–131 秒舊參考樣本的取樣從 136 張增加到 185 張；這項離線驗收目前在取樣數檢查即失敗，不能再用舊 14 則字幕快取證明完整流程等價。舊 8 則字幕快取亦僅供行程協定、時間範圍與浮點往返回歸，不代表辨識品質通過。快取一致性、SRT 可讀與單元測試均無法代替將新辨識文字及起訖點對照來源畫格；藝術字與動畫標題仍有實測誤讀。
