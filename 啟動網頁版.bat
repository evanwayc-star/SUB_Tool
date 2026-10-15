@echo off
cd /d "%~dp0"
title SUB Tool - Web
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install from https://nodejs.org
  pause & exit /b 1
)
if not exist "node_modules" (
  echo First run: installing dependencies...
  call npm install
  if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
)
echo Building single-file app (dist\index.html)...
call npm run build
if errorlevel 1 ( echo [ERROR] build failed - see messages above. & pause & exit /b 1 )
start "" "%~dp0dist\index.html"
echo.
echo Done. For live development with hot-reload, run: npm run dev
exit /b 0
