@echo off
chcp 65001 >nul
cd /d "%~dp0"
title SUB Tool - Desktop

where npm >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 找不到 npm / Node.js。
  echo 請先安裝 Node.js ^(https://nodejs.org^)，安裝後重新開機再執行本檔。
  pause & exit /b 1
)

if not exist "node_modules" (
  echo 首次執行：安裝相依套件中（需要 Node.js + 網路）...
  call npm install
  if errorlevel 1 ( echo [錯誤] npm install 失敗，請把上面訊息回報。 & pause & exit /b 1 )
)

echo 建置中...
call npm run build
if errorlevel 1 ( echo [錯誤] 建置失敗，請把上面訊息回報。 & pause & exit /b 1 )

if not exist "node_modules\electron\dist\electron.exe" (
  echo [錯誤] 找不到 electron（可能被防毒軟體刪除/隔離）。
  echo 請執行：npm install electron --save-dev   並把 electron.exe 加入防毒白名單。
  pause & exit /b 1
)

echo 啟動桌面版...（此視窗請保持開啟；關閉視窗即關閉程式）
"node_modules\electron\dist\electron.exe" .
echo.
echo 程式已關閉（離開碼 %errorlevel%）。若是非預期關閉，請把上面訊息回報。
pause
