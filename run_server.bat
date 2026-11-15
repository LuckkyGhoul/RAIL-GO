@echo off
title RailGo Train Booking System - Server (Port 8090)
cd /d "%~dp0"
echo ========================================================
echo   Starting RailGo Backend Server...
echo ========================================================

rem Free port 8090 if an old hung server process is still holding it
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8090 " ^| findstr "LISTENING"') do (
    echo [*] Cleaning up old process PID %%a on port 8090...
    taskkill /F /PID %%a >nul 2>&1
)

rem Clear stale PGlite lock file if present
if exist "%~dp0data\postgres_db\postmaster.pid" (
    del /f /q "%~dp0data\postgres_db\postmaster.pid" >nul 2>&1
)
if exist "%~dp0extra_files\data\postgres_db\postmaster.pid" (
    del /f /q "%~dp0extra_files\data\postgres_db\postmaster.pid" >nul 2>&1
)

set NODE_PATH=%~dp0extra_files\node_modules;%~dp0node_modules;%NODE_PATH%
echo [*] Web App URL: http://localhost:8090
echo.
node src/server.js
pause
