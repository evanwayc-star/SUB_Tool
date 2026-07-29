@echo off
cd /d "%~dp0"
title SUB Tool - Web Dev Server

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install from https://nodejs.org
  pause & exit /b 1
)

if not exist "node_modules" (
  echo First run: installing dependencies...
  call npm install
)

echo.
echo ==============================================================
echo   啟動本地開發伺服器 (包含多執行緒 COOP/COEP 安全標頭)
echo ==============================================================
echo.
echo 稍後會顯示網址 (例如 http://localhost:8777)，請按住 Ctrl 鍵點擊連結，
echo 或將網址複製到瀏覽器中開啟，才能正常載入 ffmpeg.wasm。
echo.

call npm run dev
pause
