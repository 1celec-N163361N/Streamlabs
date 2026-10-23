@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Starting Saba...
start "" http://localhost:4173
node server.js
pause
