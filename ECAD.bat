@echo off
rem ECAD: one-click start. Starts the local server and opens the app in your browser.
rem Keep the window open while you work; close it to stop the server.
rem Extra options pass through, e.g.  ECAD.bat --port 7700   or   ECAD.bat --lan
setlocal
cd /d "%~dp0"
title ECAD

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and start ECAD again.
  pause
  exit /b 1
)

node -e "process.exit(+process.versions.node.split('.')[0] < 20 ? 1 : 0)"
if errorlevel 1 (
  echo ECAD needs Node.js 20 or newer. Install the LTS version from https://nodejs.org and start ECAD again.
  pause
  exit /b 1
)

if not exist "node_modules\three\package.json" (
  echo Installing packages, first start only...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Package install failed. Check the internet connection and start ECAD again.
    pause
    exit /b 1
  )
)

echo ECAD is starting. Keep this window open while you work; close it to stop ECAD.
echo.
node server\main.js --open %*
if errorlevel 1 pause
