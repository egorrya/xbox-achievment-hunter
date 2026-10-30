@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install Node.js 18 or newer.
  pause
  exit /b 1
)
node -e "for (const name of Object.keys(require('./package.json').dependencies || {})) require.resolve(name)" >nul 2>&1
if errorlevel 1 (
  where npm >nul 2>&1
  if errorlevel 1 (
    echo npm is required to install dependencies.
    pause
    exit /b 1
  )
  echo Installing dependencies...
  call npm ci --omit=dev
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)
node launch.js
pause
