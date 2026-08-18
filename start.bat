@echo off
REM Keyring admin launcher - double-click to start
cd /d "%~dp0"
echo ============================================
echo   Keyring - starting local admin server...
echo ============================================
echo.
start "KeyringServer" cmd /k node server.js
ping -n 3 127.0.0.1 >nul
start "" http://localhost:4620
echo Browser opened. The server runs in the other window.
echo Close that window to stop the server.
