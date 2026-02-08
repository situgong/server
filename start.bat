@echo off
chcp 65001 >nul

echo ============================================
echo   LinguaSpark Server
echo ============================================
echo.

echo [1/4] Checking Node.js installation...
node --version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Node.js is not installed
    pause
    exit /b 1
)
for /f "delims=" %%i in ('node --version') do echo   OK: Node.js %%i found

echo [2/4] Checking Node.js version...
node -e "if (parseInt(process.version.slice(1).split('.')[0]) < 18) process.exit(1)"
if not errorlevel 1 (
    echo   OK: Node.js version is >= 18
) else (
    echo   ERROR: Node.js must be >= 18
    pause
    exit /b 1
)

echo [3/4] Starting server...

REM Create logs directory if not exists
if not exist "%~dp0logs" mkdir "%~dp0logs"

REM Change to server directory
cd /d "%~dp0"

REM Stop and delete existing instance (run in cmd context)
cmd /c "pm2 stop linguaspark" >nul 2>&1
cmd /c "pm2 delete linguaspark" >nul 2>&1

REM Start server with PM2
cmd /c "pm2 start server.js --name linguaspark --log logs\pm2.log --time"

echo [4/4] Server URLs...
echo.
echo   URL: http://127.0.0.1:3000
echo   Docs: http://127.0.0.1:3000/docs/
echo   Monitor: http://127.0.0.1:3000/monitor.html
echo.

echo ============================================
echo   Server started with PM2 (truly detached)
echo ============================================
echo.
echo Server will continue running after you close this window.
echo.
cmd /c "pm2 list"

timeout /t 3 /nobreak >nul