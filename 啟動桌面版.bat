@echo off
cd /d "%~dp0"
title SUB Tool - Desktop

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm / Node.js not found in PATH.
  echo Install Node.js from https://nodejs.org then reboot, and retry.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run: installing dependencies ^(needs Node.js + internet^)...
  call npm install
  if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
)

echo Building app...
call npm run build
if errorlevel 1 ( echo [ERROR] build failed - see messages above. & pause & exit /b 1 )

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] electron.exe missing ^(maybe removed/quarantined by antivirus^).
  echo Run: npm install electron --save-dev   then whitelist electron.exe.
  pause
  exit /b 1
)

echo Launching desktop app... keep this window open; closing it closes the app.
"node_modules\electron\dist\electron.exe" .
echo.
echo App closed ^(exit code %errorlevel%^). If this was unexpected, copy the messages above.
pause
