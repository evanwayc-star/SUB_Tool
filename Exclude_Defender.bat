@echo off
:: Check Administrator Privileges
net session >nul 2>&1
if %errorLevel% == 0 (
    echo [INFO] Administrator privileges detected.
    echo [INFO] Adding project folder to Windows Defender exclusions...
    powershell -Command "Add-MpPreference -ExclusionPath '%cd%'"
    
    echo [INFO] Reinstalling Electron...
    if exist "node_modules\electron" rmdir /s /q "node_modules\electron"
    call npm install electron --save-dev
    
    echo.
    echo [SUCCESS] All steps completed! Electron should now work.
    pause
) else (
    echo ===================================================
    echo [ERROR] This script requires Administrator privileges!
    echo Please right-click Exclude_Defender.bat and select "Run as Administrator".
    echo ===================================================
    pause
)
