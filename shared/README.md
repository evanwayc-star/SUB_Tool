# `shared/` — 兩個行程共用的領域規則

這裡放**同一條規則、兩個行程都要用**的純函式。

## 為什麼會有這個資料夾

renderer 是 ES module（Vite 打包成單一 `dist/index.html`），主程序是 CommonJS
（`package.json` 沒有 `"type": "module"`，`electron/main.js` 用 `require`）。
兩邊無法互相 import，於是幾條領域規則長期**各自維護一份手抄實作**，靠契約測試
矩陣窮舉比對兩份輸出是否相同：

| 規則 | 以前的兩份 |
|------|-----------|
| 來源聲道展開順序 | `src/channel-layout.js` ↔ `electron/channel-layout.js` |
| 片段疊層幾何 | `src/imagegeom.js imageBox()` ↔ `electron/export-plan.js imageBoxForExport()` |
| 片段長度與淡入淡出視窗 | `src/clip-fade.js` ↔ `electron/export-plan.js`（內聯三處） |

那些契約測試證明的是「兩份副本目前一致」，不是「規則本身正確」。
**規則只該有一份。** 這個資料夾就是那一份。

## 怎麼寫

一律 **CommonJS（`.cjs`）**，因為只有 CJS 兩邊都吃得下：

- 主程序：`require('../shared/channel-layout.cjs')`
- renderer：`import { … } from '../shared/channel-layout.cjs'`（Vite 會 bundle 進 `dist/index.html`，已實測）
- 測試：vitest 兩種都吃

限制（違反就會在其中一側爆掉）：

- **零相依**：不可 `require` 任何 node 內建模組或 npm 套件，也不可碰 `window`／`document`／`fs`。
  需要 `path` 的東西（例如路徑圍堵）**留在主程序**，那不是共用規則。
- **純函式**：不讀寫全域狀態，不做 I/O。
- 只放**真的兩邊都要用**的東西。單邊使用的規則留在原本的模組裡。

## 不要收進來的東西

`src/export-name-safety.js` 與 `electron/export-name-safety.js` **看起來**像一組，
實際上不是同一條規則的兩份副本——renderer 側做的是**檔名淨化**
（`sanitizeFolderSegment` / `sanitizeFileNameSegment`），主程序側做的是**路徑圍堵**
（`isPathContained`，需要 `path.resolve`）。那是兩層不同的防線，兩邊都必須存在，
**不可以合併**。

`substyle.js` 的 `styleToCss()` ↔ `styleToAssStyleLine()` 也不屬於這裡：
那是同一份規格的兩種無法合併的表達（CSS 與 ASS），矩陣契約測試是正確且必要的做法。

## 打包

`shared/**/*` 必須進安裝檔，否則主程序 `require` 會在**啟動時**失敗。
已加入 `package.json` 的 `build.win.files` 與 `build.mac.files`，
並由 `tests/packageBuildConfig.test.js` 鎖住——改那份設定時測試會紅。
