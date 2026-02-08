@echo off
chcp 65001 >nul

REM ============================================
REM LinguaSpark Server Stop Script
REM ============================================

set "PORT=3000"
set "FOUND=0"

echo ============================================
echo   LinguaSpark Server - Stop
echo ============================================
echo.

REM Kill by port
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    echo Stopping process on port %PORT% (PID: %%a)...
    taskkill /F /PID %%a >nul 2>&1
    if not errorlevel 1 (
        echo   OK: Server stopped
    ) else (
        echo   ERROR: Failed to stop process
    )
    set "FOUND=1"
)

if "%FOUND%"=="0" (
    echo   Server was not running
)

echo.
echo ============================================
echo   Done.
echo ============================================
pause