@echo off
cd /d "%~dp0"
title Rabbit POS
:loop
node --no-warnings server\index.js
echo POS stopped, restarting in 5 seconds...
timeout /t 5 >nul
goto loop
