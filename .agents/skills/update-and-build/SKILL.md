---
name: 更新與打包
description: 當使用者說「更新與打包」時，自動執行版本號更新、編譯 exe、更新文件並發佈至 GitHub 的完整發佈流程。
---

# 更新與打包 (Update and Build Workflow)

當使用者觸發此技能（例如說「更新與打包」）時，請嚴格按照以下步驟執行：

## 1. 確定並更新版本號 (Version Bump)
- 檢查 `package.json` 中的當前版本號（例如 `5.2.0`）。
- 詢問使用者要升級為主版本 (major)、次版本 (minor) 還是修補版本 (patch)，或直接根據他們最近的修改內容自行判斷（若只修復 bug 則更新 patch，例如 `5.2.1`）。
- 更新 `package.json` 中的 `version` 欄位。
- 也可以更新 `README.md` 等有標示版本的說明文件。

## 2. 更新文件與變更紀錄 (Update Documentation)
- 開啟 `docs/版本變更紀錄.md` (或類似的 Changelog 文件)。
- 根據最近一次發佈以來的修改內容，詳細撰寫新版本的變更紀錄（包括修復了什麼 bug、新增了什麼功能），確保說明清晰且有助於後續維護。

## 3. 測試與打包 (Build & Package)
- 在終端機執行測試（例如 `npm test` 或 `npx vitest`）確保修改沒有破壞既有功能。
- 執行打包指令，通常是 `npm run dist` 或相對應的 Electron 構建指令。
- 確保 `.exe` 成功產生在發佈資料夾（如 `release/`）中。

## 4. 提交與發佈至 GitHub (Commit & Push)
- 執行 `git add .`。
- 執行 `git commit -m "Release v[新版本號]: [主要變更簡述]"`。
- 執行 `git push` 將更新推送到遠端儲存庫。
- (選擇性) 如果有需要，可以建立 Git Tag 並推送：`git tag v[新版本號]`、`git push origin v[新版本號]`。

## 5. 完成回報
- 向使用者報告更新已完成，並提供此次的版本號與修改摘要。
