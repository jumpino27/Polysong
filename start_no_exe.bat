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
call :update_source_checkout || exit /b 1
call :update_helper_tools

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
exit /b %ERRORLEVEL%

:update_source_checkout
if not exist "%PROJECT_DIR%\.git" exit /b 0
where git >nul 2>nul
if errorlevel 1 (
  echo Git was not found. Skipping source update.
  exit /b 0
)
git diff --quiet -- . >nul 2>nul
if errorlevel 1 (
  echo Local tracked changes are present. Skipping git pull to avoid overwriting edits.
  exit /b 0
)
git diff --cached --quiet -- . >nul 2>nul
if errorlevel 1 (
  echo Local staged changes are present. Skipping git pull to avoid overwriting edits.
  exit /b 0
)
echo Checking for source updates from git...
git pull --ff-only
if errorlevel 1 exit /b 1
exit /b 0

:update_helper_tools
set "INSTALLER_TOOLS_DIR=%PROJECT_DIR%\tools"
if exist "%PROJECT_DIR%\scripts\prepare_installer_tools.ps1" (
  echo Checking for yt-dlp and FFmpeg helper updates...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\prepare_installer_tools.ps1"
  if errorlevel 1 echo Helper tool update failed; continuing with existing tools.
)
exit /b 0
