# 畫面文字辨識原生引擎

核心移植自使用者提供的 `kvariety-card-vision` Rust v3 實作：`video.rs`、`llm.rs`、`stitcher.rs`、`pipeline.rs`，保留五區追蹤、自適應抽幀、雲端視覺辨識、疑難複檢、字形校對及字卡／對白分類。GPUI 與原工具憑證儲存未納入。

建置與使用入口見 [開發與驗證](../../docs/開發與驗證.md)及[使用說明](../../docs/使用說明.md)。引擎以來源秒數回報結果；專案時間映射與 FPS 吸附由 renderer 負責。

## 行程協定

每個行程處理一個工作。stdin 第一行的 JSON 包含來源路徑、來源秒數 `start` 與 `end`、取樣率、語言、模型與影像寬度。Electron main 固定影音工具與快取路徑。辨識金鑰經 stdin 提供，預覽免金鑰。

- `operation: "plan"` 只做本機追蹤、取樣與快取比對，回傳 `plan`、來源秒數及實際裁切區域的 JPEG。全畫面是預設值。可選 `region` 用顯示方向的正規化 `x, y, width, height` 指定區域。
- 一般辨識輸出 `progress`、`checkpoint`、`result` 或 `error`。時間都以選定視訊串流的來源秒數表示。每個結果保留 `kind` 與 `slot`。
- `metrics` 分列初掃或複檢的待跑與命中窗數、計畫送圖張次，以及本次實際新增請求和供應商回報的 token。預覽可以精算初掃。初掃已全部快取時，也能辨認哪些複檢視窗仍缺結果。
- `maxNewRequests` 可限制該行程所有階段的新增 HTTP 請求，重試也占一次。設為 0 可完全使用已存快取。付費回應未成功寫入視窗或校字快取時，會回報錯誤。
- 手動停止並保留時，先送 `{"type":"checkpoint"}` 取得最新連續完成範圍。回覆帶 `requested: true`。引擎另於首窗、按倍數增長的完成窗數、初掃結束或故障時推送檢查點。尚未完成複檢或校字的候選字幕須另行確認。Electron 負責停止整棵行程樹。

## 品質策略與快取

依主預覽規則選取第一個非封面視訊串流。追蹤、初掃與複檢共用同一串流編號、旋轉方向與裁切區域。辨識 JPEG 依像素長寬比換算成正方形像素。智慧取樣保留基礎取樣，逐一評估相鄰錨點間的候選畫格，補入最顯著的一格。已判定疑難的視窗均送複檢。

`contentMode` 預設 `faithful`，保留可見字卡、少數對白及長駐角標的分類和時間。它會執行所選的視覺複檢，省略會改字或刪除候選字幕的純文字校字。`variety` 延用綜藝精簡規則與智慧模式的原文校字。兩種模式可沿用同批原始視覺結果，各自儲存衍生字幕。

快取識別包含來源檔案、時間範圍、取樣、影像幾何政策、辨識區域與模型。並逐視窗比對實際取樣時間。新的取格政策使用不同快取版本，可避免誤用曾擷取另一視訊軌或扭曲字形的畫面。後續相同工作僅需補齊快取缺漏。

## 驗證

先執行 `npm run native:prepare:card-vision`，再跑 `node scripts/acceptance/verify-screen-text-native.js --offline`。腳本使用桌面版的正式 runtime、原生執行檔與隨附 FFmpeg。在兩條視訊軌的合成影片燒入「OK」，讀回來源白字及預覽主軌色彩，測零請求上限與人工標註的視窗快取，重開快取後核對文字、分類、起訖和本次 token 為零。JPEG、影片與結果 JSON 會留在顯示的 TEMP 資料夾供核對。

需驗供應商實際回應時，可在有授權的素材與金鑰下使用同一腳本的 `<影片> <起點秒> <長度秒>` 入口，最多 30 秒。環境變數 `SUBTOOL_VISION_PROVIDER=gemini` 改測 Gemini，預設為 OpenAI。另可用 `SUBTOOL_VISION_TEST_KEY_STDIN=1` 從 stdin 取得臨時金鑰。

`cargo test --manifest-path electron/card-vision/Cargo.toml --locked` 包含字卡合併、重疊保留、連續 checkpoint 及原生 FFmpeg 像素驗證。原生測試需要專案的 FFmpeg／FFprobe；會比較零起點與容器 5 秒、影片 5.5 秒的來源畫格，亦檢查提前 EOF 與損壞來源。測試不呼叫雲端 API。

獨立的 SRT 離線評測使用 `subtool-card-vision --evaluate <參考.srt> <辨識.srt> [起點秒 終點秒]`，輸出 JSON。兩個時間參數決定半開標註區間。省略時會計入全份預測中的額外字幕。指標用正時間重疊、一對一配對計算逐字編輯距離，保留大小寫及標點，並報告短卡召回、誤報、起訖 P50／P95 秒與依實際字幕邊界積分的時間軸相似度。

另有需外部素材的 `offline_v3_fixture` 驗收：設定 `SUBTOOL_CARD_VISION_FIXTURE` 為原方案 `test_v3_sample` 成品目錄、`SUBTOOL_CARD_VISION_VIDEO` 為該份原始影片，執行 `cargo test --manifest-path electron/card-vision/Cargo.toml --locked offline_v3_fixture -- --ignored --nocapture`。測試先比對影片大小與修改時間，重算本機追蹤，再逐項核對取樣時間；只把相符的 VLM／複檢／校字快取複製到新建的系統暫存目錄。完整流程的輸出 JSON 必須與參考相同，另讀回 SRT 並留下三張來源畫面與 `offline-verification.json`。所有測試編譯均拒絕 HTTP，因此任何快取缺漏會讓驗收失敗，不會改呼叫雲端。

取消補幀上限後，75–131 秒舊參考樣本的取樣從 136 張增加到 185 張；這項離線驗收目前在取樣數檢查即失敗，不能再用舊 14 則字幕快取證明完整流程等價。舊 8 則字幕快取亦僅供行程協定、時間範圍與浮點往返回歸，不代表辨識品質通過。快取一致性、SRT 可讀與單元測試均無法代替將新辨識文字及起訖點對照來源畫格；藝術字與動畫標題仍有實測誤讀。
