@echo off
title HAkrathon Hub DEMO
cd /d "%~dp0"
if not exist node_modules call npm install --omit=dev
node scripts\demo.js
pause
