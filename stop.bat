@echo off
chcp 65001 >nul
setlocal

REM ============================================
REM LinguaSpark Server Stop Script
REM ============================================

set "SCRIPT_DIR=%~dp0"
set "PORT=3000"

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
    goto done
)

echo   Server was not running

:done
echo ============================================
pause
endlocal
exit /b 0