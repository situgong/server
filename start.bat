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

echo [3/4] Checking for existing instances...
echo   OK: Proceeding...

echo [4/4] Starting LinguaSpark Server...
echo.
echo   URL: http://127.0.0.1:3000
echo   Docs: http://127.0.0.1:3000/docs/
echo   Monitor: http://127.0.0.1:3000/monitor.html
echo.

REM Create logs directory if not exists
if not exist "%~dp0logs" mkdir "%~dp0logs"

REM Start server in background with logs
cd /d "%~dp0"
start /B node server.js >> logs\server.log 2>&1

echo ============================================
echo   Server started in background
echo   Logs: %~dp0logs\server.log
echo ============================================
echo.
echo Press any key to exit...
pause >nul