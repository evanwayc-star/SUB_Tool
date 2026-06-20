@echo off
cd /d "%~dp0"
title SUB Tool - Web
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install from https://nodejs.org
  pause & exit /b 1
)
if not exist "node_modules" (
  echo First run: installing dependencies...
  call npm install
)
echo Building single-file app (dist\index.html)...
call npm run build
start "" "%~dp0dist\index.html"
echo.
echo Done. For live development with hot-reload, run: npm run dev
exit /b 0
