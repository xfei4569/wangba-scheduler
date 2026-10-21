@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或 24 LTS，再重新运行。
  pause
  exit /b 1
)
if not exist node_modules (
  call npm ci --include=dev
  if errorlevel 1 exit /b 1
)
call npm run setup
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1
start "" "http://127.0.0.1:3899"
call npm start
pause
