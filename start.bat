@echo off
title HAkrathon Hub
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing packages, one time only...
  call npm install --omit=dev || (pause & exit /b 1)
)
node server\index.js
pause
