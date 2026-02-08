@echo off
chcp 65001 >nul
setlocal

REM ============================================
REM LinguaSpark Server Start Script
REM ============================================

set "SCRIPT_DIR=%~dp0"
set "PORT=3000"
set "URL=http://127.0.0.1:%PORT%"

echo ============================================
echo   LinguaSpark Server
echo ============================================
echo.

REM Check Node.js installation
echo [1/4] Checking Node.js installation...
node --version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Node.js is not installed or not in PATH
    echo   Please install Node.js >= 18 from https://nodejs.org/
    goto wait_exit
)
for /f "tokens=*" %%i in ('node --version') do set "NODE_VERSION=%%i"
echo   OK: Node.js %NODE_VERSION% found

REM Check Node.js version
echo [2/4] Checking Node.js version...
for /f "tokens=2 delims=v." %%v in ("%NODE_VERSION%") do set "MAJOR=%%v"
if "%MAJOR%" lss "18" (
    echo   ERROR: Node.js version must be >= 18 (current: %NODE_VERSION%)
    goto wait_exit
)
echo   OK: Node.js version is >= 18

REM Kill existing server process
echo [3/4] Checking for existing instances...
set "PID_FILE=%SCRIPT_DIR%.server.pid"
if exist "%PID_FILE%" (
    for /f "tokens=*" %%p in (%PID_FILE%) do (
        set "OLD_PID=%%p"
        tasklist /FI "PID eq %OLD_PID%" 2>nul | find /I /N "%OLD_PID%" >nul
        if not errorlevel 1 (
            echo   Stopping existing process (PID: %OLD_PID%)...
            taskkill /F /PID %OLD_PID% >nul 2>&1
            timeout /t 2 /nobreak >nul
        )
    )
    del "%PID_FILE%" >nul 2>&1
)

REM Check if port is still in use
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo   WARNING: Port %PORT% is still in use, attempting to free it...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 1 /nobreak >nul
)
echo   OK: Port %PORT% is available

REM Start the server
echo [4/4] Starting LinguaSpark Server...
echo.
echo   URL: %URL%
echo   Docs: %URL%/docs/
echo   Monitor: %URL%/monitor.html
echo.
echo ============================================
echo   Server logs (Ctrl+C to stop):
echo ============================================
echo.

cd /d "%SCRIPT_DIR%"
node server.js

:wait_exit
pause
endlocal
exit /b %ERRORLEVEL%