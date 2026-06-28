# SUB Tool — 多軌時間軸上字幕工具

上字幕編輯器，同一份 `dist/index.html` 同時支援**網頁版**與 **Electron 桌面版**。

## 功能摘要

- 多軌時間軸：拖曳字幕區塊調整起訖、換軌、磁吸對齊
- JKL 穿梭輪（最高 5×）、`←/→` 逐格定位
- 匯入 / 匯出：SRT、ASS/SSA、Adobe Encore 時碼、純文字
- FPS 自動偵測（23.976 / 24 / 25 / 29.97 DF/NDF / 30）
- 多音軌混音器（獨奏 / 靜音 / 電平表）
- 桌面版：MXF / MKV / AVI 等非原生格式（系統 ffmpeg）、mpv 秒開

## 版本比較

| 版本 | 啟動方式 | 媒體能力 |
|------|----------|----------|
| 網頁版 | `啟動工具.bat` 或開啟 `dist/index.html` | MP4 / MOV(H.264) / MP3 / WAV |
| **桌面版（推薦）** | `啟動桌面版.bat` 或雙擊 `.subtool` 專案檔 | 上述 + MXF / MKV / AVI / 多音軌 / 雙擊開啟專案 |

## 快速開始

### 前置需求

- [Node.js](https://nodejs.org) 18+
- [ffmpeg](https://ffmpeg.org)（桌面版 MXF / 多音軌需要；放入 PATH 或 `C:\Program Files\FFMPEG\bin\`）

### 網頁版

```bash
npm install       # 第一次安裝
npm run build     # 打包成 dist/index.html
# 開啟 dist/index.html（或雙擊 啟動工具.bat 自動執行上述步驟）
```

### 桌面版

```bash
npm install          # 第一次安裝
npm run electron     # build + 啟動 Electron
# 或雙擊 啟動桌面版.bat
```

### 開發模式（熱更新）

```bash
# 終端機 1
npm run dev
# 終端機 2
npm run electron:dev    # 連 dev server + 開 DevTools
```

## 打包安裝檔（exe）

```bash
npm run dist    # electron-builder → release/ 下的 win exe 安裝檔
```

## 文件索引

所有說明文件位於 [`docs/`](docs/) 資料夾。

| 文件 | 說明 |
|------|------|
| [docs/#使用說明.md](docs/%23使用說明.md) | 使用者操作手冊、快捷鍵、字幕格式 |
| [docs/#開發說明.md](docs/%23開發說明.md) | 開發環境、npm 指令、模組結構 |
| [docs/#驗證說明.md](docs/%23驗證說明.md) | 桌面版大檔 / 混音器驗證清單 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模組架構、資料流、關鍵函式 |
| [docs/ELECTRON_MAINTENANCE.md](docs/ELECTRON_MAINTENANCE.md) | Electron IPC / ffmpeg / mpv 維護指南 |
| [docs/FPS_時碼一致性.md](docs/FPS_%E6%99%82%E7%A2%BC%E4%B8%80%E8%87%B4%E6%80%A7.md) | FPS / 時碼設計原則（維護者必讀） |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 版本歷史 |
| [shortcuts.csv](shortcuts.csv) | 完整快捷鍵對照表（CSV） |
