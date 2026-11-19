@echo off
rem OneChat launcher. Opens the desktop app: its own window, with the OneChat icon on the taskbar.
rem "OneChat.cmd --browser" keeps the old way (a browser window, visible console); that window
rem carries the browser's taskbar icon, which is why it is no longer the default.
cd /d "%~dp0"
if /i "%~1"=="--browser" goto browser
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
  exit /b 0
)
:browser
node --use-system-ca server.js --open
