# shared/ 共用領域規則

`shared/` 只放 renderer 與 Electron main 都需要的同一條純規則。

Renderer 是由 Vite 打包的 ES modules；main 是 CommonJS。零相依 `.cjs` 可同時被兩邊載入：

```js
// main
const geometry = require('../shared/image-geometry.cjs');

// renderer
import { imageBox } from '../shared/image-geometry.cjs';
```

## 目前內容

| 檔案 | 唯一責任 |
|---|---|
| `channel-layout.cjs` | 來源聲道展開順序 |
| `clip-fade.cjs` | 片段長度與淡入淡出視窗 |
| `delivery-resolution.cjs` | 交付解析度正規化 |
| `image-geometry.cjs` | 圖片／片段疊層幾何 |

## 加入條件

必須同時符合：

- renderer 與 main 都真的需要。
- 是同一條領域規則，不是兩個相似功能。
- 純函式，不做 I/O，不讀寫全域狀態。
- 不依賴 Node 內建模組、npm 套件、DOM、`window` 或 `document`。
- 有直接測試與兩端整合測試。

不符合就留在原本 owner。

## 不可合併的例子

- Renderer 的檔名淨化與 main 的路徑圍堵是兩層安全防線。
- CSS 與 ASS 是同一字幕規格的兩種表達，不是可共用的一個輸出函式。
- File capability 需要主程序狀態與 path 解析，不能移入 shared。

只用契約測試比較兩份手抄公式，最多證明兩份副本相同。若它們真的是同一條規則，應搬到 shared 只保留一份。

## 封裝

`shared/**/*` 必須進 Windows 與 macOS 安裝包；`tests/packageBuildConfig.test.js` 會守住這項設定。缺少時 Electron main 會在啟動階段 require 失敗。
