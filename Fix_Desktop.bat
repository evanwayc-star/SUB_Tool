@echo off
echo [INFO] Setting local temp directory to avoid Windows Defender scanning during extraction...
if not exist "%cd%\.tmp" mkdir "%cd%\.tmp"
set TMP=%cd%\.tmp
set TEMP=%cd%\.tmp
set electron_config_cache=%cd%\.electron_cache

echo [INFO] Cleaning up broken electron package...
if exist "node_modules\electron" rmdir /s /q "node_modules\electron"

echo [INFO] Downloading and installing Electron... (This might take a few minutes)
call npm install electron@32.3.3 --save-dev

if exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo [SUCCESS] electron.exe is successfully installed!
    echo [INFO] Launching Desktop App...
    call npm run electron
) else (
    echo.
    echo [ERROR] electron.exe is STILL missing. Windows Defender might still be blocking it.
)
pause
