@echo off
title HAkrathon code runner setup
cd /d "%~dp0"
where docker >nul 2>nul || (echo Docker Desktop is not installed. Install it from https://www.docker.com/products/docker-desktop/ then run this again. & pause & exit /b 1)
docker version --format "{{.Server.Version}}" >nul 2>nul || (echo Docker Desktop is installed but not running. Start Docker Desktop, wait for it to say "running", then run this again. & pause & exit /b 1)
echo Building the sandbox image (takes a few minutes the first time)...
docker build -t hakrathon-runner:latest runner || (pause & exit /b 1)
echo.
echo Testing the sandbox...
docker run --rm --network none hakrathon-runner:latest python3 --version
docker run --rm --network none hakrathon-runner:latest node --version
docker run --rm --network none hakrathon-runner:latest java -version
echo.
echo Done. Restart the portal (start.bat) and check Admin ^> Overview ^> Code runner.
pause
