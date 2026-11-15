@echo off
cd /d "%~dp0"
set NODE_PATH=%~dp0extra_files\node_modules;%~dp0node_modules;%NODE_PATH%
node sync_db.js
pause
