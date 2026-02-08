@echo off
chcp 65001 >nul
echo ============================================
echo   LinguaSpark Server - Stop
echo ============================================
echo.

REM Check if PM2 exists
where pm2 >nul 2>&1
if errorlevel 1 (
    echo PM2 not found, using alternative method...
    echo Stopping server on port 3000...
    netstat -ano | findstr "3000" | findstr "LISTENING" > .pids.txt
    for /f "tokens=5" %%a in (.pids.txt) do taskkill /F /PID %%a
    del .pids.txt >nul 2>&1
) else (
    echo Stopping PM2 process...
    cmd /c "pm2 stop linguaspark"
    cmd /c "pm2 delete linguaspark"
    echo.
    echo PM2 process stopped.
)

echo Done.
echo ============================================
pause