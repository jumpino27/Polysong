@echo off
setlocal EnableExtensions

set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"
set "DEV_DIR=%PROJECT_DIR%\.dev"
set "PROJECT_NODE_DIR=%DEV_DIR%\node"
set "PROJECT_PNPM_BIN=%DEV_DIR%\pnpm\node_modules\.bin"
set "PROJECT_CARGO_HOME=%DEV_DIR%\cargo"
set "PROJECT_RUSTUP_HOME=%DEV_DIR%\rustup"
set "TAURI_CLI=%PROJECT_DIR%\frontend\node_modules\.bin\tauri.cmd"
set "NSIS_DIR=%PROJECT_DIR%\target\release\bundle\nsis"
set "DIST_DIR=%PROJECT_DIR%\dist"
set "INSTALLER_OUT=%DIST_DIR%\installed.exe"
set "INSTALLER_TOOLS_DIR=%PROJECT_DIR%\src-tauri\installer-tools\windows"

cd /d "%PROJECT_DIR%" || exit /b 1

if exist "%PROJECT_NODE_DIR%\node.exe" set "PATH=%PROJECT_NODE_DIR%;%PATH%"
if exist "%PROJECT_PNPM_BIN%\pnpm.cmd" set "PATH=%PROJECT_PNPM_BIN%;%PATH%"
if exist "%PROJECT_CARGO_HOME%\bin\cargo.exe" (
  set "CARGO_HOME=%PROJECT_CARGO_HOME%"
  set "RUSTUP_HOME=%PROJECT_RUSTUP_HOME%"
  set "PATH=%PROJECT_CARGO_HOME%\bin;%PATH%"
)

if not exist "%TAURI_CLI%" (
  echo Tauri CLI was not found. Running first_setup_no_exe.bat to prepare project tools.
  call "%PROJECT_DIR%\first_setup_no_exe.bat" --skip-build || exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Run first_setup_no_exe.bat first.
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo Cargo was not found. Run first_setup_no_exe.bat first.
  exit /b 1
)

echo.
echo == Preparing bundled Windows helper tools ==
call :prepare_installer_tools || exit /b 1

echo.
echo == Building Polysong Windows installer ==
powershell -NoProfile -ExecutionPolicy Bypass -Command "& $env:TAURI_CLI build --bundles nsis --no-sign; exit $LASTEXITCODE"
if errorlevel 1 exit /b 1

if not exist "%NSIS_DIR%" (
  echo NSIS output folder was not found: "%NSIS_DIR%"
  exit /b 1
)

if not exist "%DIST_DIR%" mkdir "%DIST_DIR%" || exit /b 1

for /f "delims=" %%F in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$installer = Get-ChildItem -LiteralPath $env:NSIS_DIR -Filter *.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if (-not $installer) { exit 1 }; $installer.FullName"') do set "GENERATED_INSTALLER=%%F"

if not defined GENERATED_INSTALLER (
  echo No NSIS installer .exe was generated in "%NSIS_DIR%".
  exit /b 1
)

copy /Y "%GENERATED_INSTALLER%" "%INSTALLER_OUT%" >nul || exit /b 1

call :sign_installer || exit /b 1

echo.
echo Installer created:
echo "%INSTALLER_OUT%"
echo.
echo The installer installs the Tauri desktop app, bundled yt-dlp, bundled ffmpeg/ffprobe, and initializes songs folders beside the installed executable.
exit /b 0

:prepare_installer_tools
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\prepare_installer_tools.ps1"
if errorlevel 1 exit /b 1
exit /b 0

:sign_installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\sign_installer.ps1"
if errorlevel 1 exit /b 1
exit /b 0
