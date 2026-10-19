# shared/ 共用領域規則

此目錄只保存 renderer 與 Electron 主程序共同使用的純領域規則。Renderer 使用 ESM，主程序使用 CommonJS；零相依 `.cjs` 讓兩端載入同一份實作，避免各自手抄公式。

```js
// electron/：CommonJS
const { imageBox } = require('../shared/image-geometry.cjs');

// src/：由 Vite 處理的 ESM
import { imageBox } from '../shared/image-geometry.cjs';
```

名稱定義見 [CONTEXT.md](../CONTEXT.md)，模組邊界見[技術架構說明](../docs/技術架構說明.md)。

## 目前內容

| 檔案 | 共用規則 |
|---|---|
| `audio-loudness.cjs` | 音訊效果快照、母素材路徑、限制器選項與濾鏡、聲量報告解析 |
| `channel-layout.cjs` | 來源 stream／channel 展開順序及快取聲道檔名 |
| `clip-fade.cjs` | 片段長度與淡入淡出時間窗 |
| `clip-visual.cjs` | 固定畫面來源時間、末格索引與靜態視覺片段判斷 |
| `delivery-formats.cjs` | 九種交付選項、固定規格、BD 模式與音訊編組限制 |
| `delivery-frame-rate.cjs` | 標準交付 FPS、精確 NTSC 有理數、解析與格率比對 |
| `delivery-resolution.cjs` | 交付尺寸、建議碼率及 TC 規格派生 |
| `image-geometry.cjs` | 圖片與片段疊層幾何 |
| `media-source-clock.cjs` | 播放器／來源秒數原點映射與裁切內來源微秒目標 |

## 加入條件

先確認真實 caller，再同時核對：

- renderer 與 main 都需要同一條領域規則。
- 輸入、輸出能用一般資料表達，不依賴呼叫端狀態。
- 不做 I/O，不讀寫全域狀態。
- 不依賴 Node 內建模組、npm 套件、DOM、`window` 或 `document`。
- 以已知結果測試規則本身，並涵蓋兩端 caller 的整合契約。

不符合就留在原有 owner，不為了目錄對稱搬進來。契約測試比對兩份手抄公式，最多證明副本一致；確認是同一條規則後，才搬到這裡保留單一實作。

## 不可合併的例子

| 看似相近的程式 | 必須分開的原因 |
|---|---|
| renderer 檔名淨化、main 路徑圍堵 | 前者處理輸入，後者守住實體檔案邊界，是兩層防線 |
| HTML／CSS 與 ASS 樣式輸出 | 同一生效樣式在不同呈現器的表達，不能用一個輸出函式取代 |
| 檔案 capability 與純路徑資料處理 | capability 需要主程序授權狀態與實體路徑核對 |

共用規則不代表合併授權、生命週期或格式 adapter。Proxy 取消與程序 close 屏障也屬於主程序 owner。

## 封裝

修改後依序核對：

1. Node `require()` 與 renderer 相對 ESM import 都取得實際 export。
2. Vite 開發模式與單檔 build 都能載入；CJS 預打包清單由 `vite.config.mjs` 讀取本目錄產生。
3. Windows 與 macOS 都封裝 `shared/**/*.cjs`；standalone watchdog 需要的檔案也符合 `asarUnpack`。
4. 本目錄仍在 `npm run lint` 參數內。

`tests/viteSharedDevelopment.test.js` 核對真實開發伺服器及兩端規則，`tests/packageBuildConfig.test.js` 核對封裝設定。缺少 shared 檔案時，主程序會在 `require()` 階段失敗；renderer build 成功不能代替這項檢查。
