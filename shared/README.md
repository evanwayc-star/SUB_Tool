# shared/ 共用領域規則

`shared/*.cjs` 存放 renderer 與 Electron 主程序共同使用的純函式。主程序可用 `require('../shared/image-geometry.cjs')` 取得 `imageBox`，renderer 用 `import { imageBox } from '../shared/image-geometry.cjs'`。[領域詞彙](../CONTEXT.md) · [技術架構](../docs/技術架構說明.md)

## 加入條件

先找出兩端實際使用這條規則的呼叫處。只有兩端執行同一領域規則、輸入輸出皆可用一般資料表達時，才收斂為單一實作。

- 零相依。避開 Node 內建模組、npm 套件、DOM、`window`、`document`。
- 無 I/O，不讀寫全域狀態或呼叫端私有狀態。
- 以已知正確結果驗證規則，再測兩端 caller。只比對兩份副本可能讓相同錯誤通過。

## 依問題找檔案

| 規則 | 檔案 |
|---|---|
| 音訊效果快照、母素材路徑、限制器選項／濾鏡、聲量報告 | `audio-loudness.cjs` |
| 來源 stream／channel 展開順序、聲道快取檔名 | `channel-layout.cjs` |
| 片段時長、淡入淡出時間窗 | `clip-fade.cjs` |
| 固定畫面的來源時間、末格索引、靜態視覺判斷 | `clip-visual.cjs` |
| 影音交付選項、固定規格、BD 模式及音訊編組限制 | `delivery-formats.cjs` |
| MP4／MOV 書籤範圍、同時點合併、FFmetadata | `delivery-chapters.cjs` |
| 標準 FPS、NTSC 有理數、格率解析與比對 | `delivery-frame-rate.cjs` |
| 交付尺寸、建議碼率、衍生 TC 規格 | `delivery-resolution.cjs` |
| 圖片／片段疊層幾何 | `image-geometry.cjs` |
| 播放器與來源時間的原點、裁切內的微秒目標 | `media-source-clock.cjs` |
| 專案畫布寬高及像素額度 | `project-canvas.cjs` |
| UTF-16LE BOM 編碼、UTF-8／UTF-16LE／UTF-16BE 解碼 | `text-encoding.cjs` |

## 保留在各層的責任

- renderer 淨化檔名，main 圍堵實體路徑。兩道防線各守一層。檔案 capability 的授權狀態與實體路徑核對也留在 main。
- HTML／CSS 與 ASS 共用生效樣式，各自序列化為目標格式。
- Proxy 取消與等待程序 close 屬於主程序的生命週期。

## 封裝驗證

1. 兩端實際載入 export，Vite 開發伺服器與單檔 build 都要成功。`vite.config.mjs` 從本目錄產生 CJS 預打包清單。[開發模式測試](../tests/viteSharedDevelopment.test.js)
2. Windows、macOS 均須包含 `shared/**/*.cjs`，standalone watchdog 依賴的檔案另符合 `asarUnpack`。缺檔會在主程序 `require()` 時失敗。[封裝測試](../tests/packageBuildConfig.test.js)
3. `npm run lint` 的檢查目錄必須包括 `shared/`。
