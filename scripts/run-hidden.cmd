@echo off
rem Starts OneChat for the Desktop shortcut (no console) and keeps it running:
rem if the server stops abnormally it is started again, up to 5 times per launch.
rem A normal stop (window closed for 10 minutes, or Quit) ends this script.
rem --use-system-ca: trust the Windows certificate store (antivirus TLS inspection).
cd /d "%~dp0.."
set n=0
node --use-system-ca server.js --open >> "%TEMP%\onechat.log" 2>&1
:again
if %errorlevel% equ 0 exit /b 0
set /a n+=1
if %n% gtr 5 exit /b 1
echo %date% %time% server stopped with code %errorlevel%, restart %n% >> "%TEMP%\onechat.log"
node --use-system-ca server.js --auto-exit >> "%TEMP%\onechat.log" 2>&1
goto again
