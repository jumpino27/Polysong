@echo off
setlocal

set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"
set "DEV_DIR=%PROJECT_DIR%\.dev"
set "PROJECT_NODE_DIR=%DEV_DIR%\node"
set "PROJECT_PNPM_BIN=%DEV_DIR%\pnpm\node_modules\.bin"
set "PROJECT_CARGO_HOME=%DEV_DIR%\cargo"
set "PROJECT_RUSTUP_HOME=%DEV_DIR%\rustup"
set "POLYSONG_DATA_DIR=%PROJECT_DIR%"
set "POLYSONG_BACKEND_PORT=4778"
set "VITE_POLYSONG_BACKEND_URL=http://127.0.0.1:%POLYSONG_BACKEND_PORT%"

if exist "%PROJECT_NODE_DIR%\node.exe" set "PATH=%PROJECT_NODE_DIR%;%PATH%"
if exist "%PROJECT_PNPM_BIN%\pnpm.cmd" set "PATH=%PROJECT_PNPM_BIN%;%PATH%"
if exist "%PROJECT_CARGO_HOME%\bin\cargo.exe" (
  set "CARGO_HOME=%PROJECT_CARGO_HOME%"
  set "RUSTUP_HOME=%PROJECT_RUSTUP_HOME%"
  set "PATH=%PROJECT_CARGO_HOME%\bin;%PATH%"
)

cd /d "%PROJECT_DIR%" || exit /b 1

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Run first_setup_no_exe.bat first.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo Cargo was not found. Run first_setup_no_exe.bat first.
  pause
  exit /b 1
)

if not exist "%PROJECT_DIR%\frontend\node_modules" (
  echo Frontend dependencies are missing. Run first_setup_no_exe.bat first.
  pause
  exit /b 1
)

echo Starting Polysong backend and browser frontend.
echo Data directory: "%POLYSONG_DATA_DIR%"
echo Backend URL: "%VITE_POLYSONG_BACKEND_URL%"
echo Close this window or press Ctrl+C to stop the dev servers.
start "" "http://localhost:5173"
call pnpm dev

