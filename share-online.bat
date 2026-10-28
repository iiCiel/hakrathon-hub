@echo off
rem Gives the portal a public https link through ngrok (for people not on the venue Wi-Fi).
rem Keep start.bat running in another window first.
where ngrok >nul 2>nul || (echo ngrok is not installed. & pause & exit /b 1)
ngrok http 3000
