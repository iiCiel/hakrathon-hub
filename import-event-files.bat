@echo off
title HAkrathon Hub - import registration and organizer schedule
cd /d "%~dp0"
rem Imports the newest "HAkrathon 2026 Student Registration*.xlsx" and "HAkrathon_2026_Organizer_Schedule*.docx"
rem from your Desktop into data\ (the live portal's data folder). Safe to run again with newer files,
rem also while start.bat is running. Check-ins are never undone.
set "XLSX="
set "DOCX="
for %%f in ("%USERPROFILE%\Desktop\HAkrathon 2026 Student Registration*.xlsx") do set "XLSX=%%~f"
for %%f in ("%USERPROFILE%\Desktop\HAkrathon_2026_Organizer_Schedule*.docx") do set "DOCX=%%~f"
if defined XLSX (node tools\import-registration.js "%XLSX%") else (echo No registration .xlsx found on the Desktop.)
echo.
if defined DOCX (node tools\import-schedule.js "%DOCX%") else (echo No organizer schedule .docx found on the Desktop.)
echo.
echo Now open Admin ^> Check-in and Admin ^> Staff schedule (reload the page if it is open).
pause
