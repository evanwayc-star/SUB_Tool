@echo off
cd /d "%~dp0"
title SUB Tool - Desktop
if not exist "node_modules" (
  echo First run: installing dependencies (needs Node.js + internet)...
  call npm install
)
echo Building app...
call npm run build
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron not installed. Run: npm install
  pause & exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
