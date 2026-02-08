@echo off
chcp 65001 >nul
echo ============================================
echo   LinguaSpark Server - Stop
echo ============================================
echo.
echo Stopping server on port 3000...
taskkill /F /PID 2>nul >nul
netstat -ano | findstr "3000" | findstr "LISTENING" > .pids.txt
for /f "tokens=5" %%a in (.pids.txt) do taskkill /F /PID %%a
del .pids.txt >nul 2>&1
echo Done.
echo ============================================
pause