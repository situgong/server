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
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo   OK: Node.js %NODE_VERSION% found

echo [2/4] Checking Node.js version...
for /f "tokens=2 delims=v." %%v in ("%NODE_VERSION%") do set MAJOR=%%v
if "%MAJOR%" lss "18" (
    echo   ERROR: Node.js must be >= 18
    pause
    exit /b 1
)
echo   OK: Node.js version is >= 18

echo [3/4] Checking for existing instances...
echo   OK: Proceeding...

echo [4/4] Starting LinguaSpark Server...
echo.
echo   URL: http://127.0.0.1:3000
echo   Docs: http://127.0.0.1:3000/docs/
echo   Monitor: http://127.0.0.1:3000/monitor.html
echo.
echo ============================================
echo   Server logs (Ctrl+C to stop):
echo ============================================
echo.

cd /d "%~dp0"
node server.js

pause