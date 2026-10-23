@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Saba - Subathon timer
start "" http://localhost:4173
node server.js
pause
