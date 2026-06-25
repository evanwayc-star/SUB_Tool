# Electron 專案維護手冊

本文件旨在協助維護者快速理解本專案的架構、開發流程以及運維注意事項。

## 1. 系統架構總覽
本專案採用 **Vite + Electron** 架構，分為兩大核心進程：
* **Main Process (主程序):** 負責底層 Node.js 操作、系統存取、視窗管理。
* **Renderer Process (渲染進程):** 負責 UI 介面呈現 (Vite 驅動)。
* **Preload Script (橋接層):** 負責安全地暴露有限的 Node.js 功能給渲染進程。

[Image of Electron process architecture diagram]

## 2. IPC 通訊機制 (重要)
前後端溝通透過 IPC (Inter-Process Communication) 進行，請務必遵循以下規範：

| Channel 名稱 | 方向 | 用途 | 資料格式 (TS Interface) |
| :--- | :--- | :--- | :--- |
| `app:on-event` | Renderer -> Main | 觸發後端功能 | `{ id: string, payload: any }` |
| `app:reply-data` | Main -> Renderer | 回傳結果 | `{ success: boolean, data: any }` |

## 3. 開發環境與架構說明
* **Vite 設定:** `vite.config.ts` 同時處理兩進程的打包邏輯。若需加入新的 Node 原生模組，請務必更新 `external` 與 `build` 設定。
* **安全性:** 本專案禁止在渲染進程中直接執行 Node.js API，所有底層存取均透過 `preload.ts` 暴露的 `contextBridge` 進行。

## 4. 打包與發布
本專案使用 `electron-builder` 進行打包。

* **打包指令:** `npm run build`
* **關鍵檔案:** `electron-builder.yml`
* **注意事項:**
    * 打包前請確保所有環境變數 (如 `APP_VERSION`, `API_URL`) 已正確設定。
    * 簽名流程需要特定的憑證檔案，存放於 CI/CD 環境變數中。

## 5. 常見維護清單 (Troubleshooting)
1.  **若主程序啟動失敗:** 檢查 `main/` 目錄下的 Node.js 相依性，並確認是否漏掉 `npm install`。
2.  **若 UI 無法連線至後端:** 檢查 `preload.ts` 中的 `contextBridge` 是否成功暴露對應的 IPC channel。
3.  **若原生模組載入錯誤:** 請檢查 `electron-builder` 是否正確處理了 native module 的 rebuild 流程。

## 6. 變更紀錄 (CHANGELOG)
請參閱根目錄下的 `CHANGELOG.md` 以了解歷次版本變更。

---
*文件維護建議：每次架構異動或新增 IPC 通道時，請同步更新本文件與對應的架構圖。*
