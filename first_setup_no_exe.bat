@echo off
setlocal

set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"
set "DEV_DIR=%PROJECT_DIR%\.dev"
set "PROJECT_TOOLS_DIR=%PROJECT_DIR%\tools"
set "PROJECT_NODE_DIR=%DEV_DIR%\node"
set "PROJECT_PNPM_HOME=%DEV_DIR%\pnpm"
set "PROJECT_PNPM_BIN=%PROJECT_PNPM_HOME%\node_modules\.bin"
set "PROJECT_CARGO_HOME=%DEV_DIR%\cargo"
set "PROJECT_RUSTUP_HOME=%DEV_DIR%\rustup"
set "RUSTUP_INIT=%DEV_DIR%\rustup-init.exe"
set "START_BAT=%PROJECT_DIR%\start_no_exe.bat"
set "FIRST_SETUP=%~f0"

set "SKIP_INSTALL="
set "SKIP_BUILD="

:parse_args
if "%~1"=="" goto parsed_args
if /I "%~1"=="--skip-install" set "SKIP_INSTALL=1"
if /I "%~1"=="--skip-build" set "SKIP_BUILD=1"
shift
goto parse_args

:parsed_args
cd /d "%PROJECT_DIR%" || exit /b 1
if not exist "%DEV_DIR%" mkdir "%DEV_DIR%" || exit /b 1

echo.
echo == Checking Node.js ==
call :ensure_node || exit /b 1

echo.
echo == Checking pnpm ==
call :ensure_pnpm || exit /b 1

echo.
echo == Checking Rust/Cargo ==
call :ensure_rust || exit /b 1

echo.
echo == Installing project dependencies ==
if defined SKIP_INSTALL (
  echo Skipped dependency install because --skip-install was passed.
) else (
  call pnpm install || exit /b 1
  call pnpm -C frontend install || exit /b 1
)

echo.
echo == Checking Tauri CLI ==
if not exist "%PROJECT_DIR%\frontend\node_modules\.bin\tauri.cmd" (
  echo Tauri CLI was not found in frontend dependencies. Installing it locally.
  call pnpm -C frontend add -D @tauri-apps/cli@^2.9.3 || exit /b 1
)
call pnpm -C frontend exec tauri --version || exit /b 1

echo.
echo == Preparing media helper tools ==
call :ensure_media_tools || exit /b 1

echo.
echo == Creating start_no_exe.bat ==
call :write_start_bat || exit /b 1

echo.
echo == Building project ==
if defined SKIP_BUILD (
  echo Skipped build because --skip-build was passed.
) else (
  call pnpm -C frontend build || exit /b 1
  call cargo build --workspace || exit /b 1
)

echo.
echo Setup complete. Run start_no_exe.bat to start the browser frontend and backend.
exit /b 0

:ensure_node
if exist "%PROJECT_NODE_DIR%\node.exe" (
  set "PATH=%PROJECT_NODE_DIR%;%PATH%"
  for /f "delims=" %%V in ('node --version') do echo Using project-local Node.js %%V
  exit /b 0
)

where node >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%V in ('node --version') do echo Using installed Node.js %%V
  exit /b 0
)

echo Node.js was not found. Installing latest LTS Node.js into .dev\node.
set "NODE_ZIP=%DEV_DIR%\node.zip"
set "NODE_EXTRACT=%DEV_DIR%\node-extract"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'; $release = $index | Where-Object { $_.lts -ne $false -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1; if (-not $release) { throw 'Could not resolve Node.js LTS win-x64 build.' }; $version = $release.version; $url = 'https://nodejs.org/dist/' + $version + '/node-' + $version + '-win-x64.zip'; if (Test-Path $env:NODE_EXTRACT) { Remove-Item -LiteralPath $env:NODE_EXTRACT -Recurse -Force }; if (Test-Path $env:PROJECT_NODE_DIR) { Remove-Item -LiteralPath $env:PROJECT_NODE_DIR -Recurse -Force }; Invoke-WebRequest -Uri $url -OutFile $env:NODE_ZIP; Expand-Archive -LiteralPath $env:NODE_ZIP -DestinationPath $env:NODE_EXTRACT -Force; $src = Get-ChildItem -LiteralPath $env:NODE_EXTRACT -Directory | Select-Object -First 1; Move-Item -LiteralPath $src.FullName -Destination $env:PROJECT_NODE_DIR; Remove-Item -LiteralPath $env:NODE_ZIP -Force; Remove-Item -LiteralPath $env:NODE_EXTRACT -Recurse -Force" || exit /b 1
set "PATH=%PROJECT_NODE_DIR%;%PATH%"
for /f "delims=" %%V in ('node --version') do echo Installed project-local Node.js %%V
exit /b 0

:ensure_pnpm
if exist "%PROJECT_PNPM_BIN%\pnpm.cmd" (
  set "PATH=%PROJECT_PNPM_BIN%;%PATH%"
  for /f "delims=" %%V in ('pnpm --version') do echo Using project-local pnpm %%V
  exit /b 0
)

where pnpm >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%V in ('pnpm --version') do echo Using installed pnpm %%V
  exit /b 0
)

echo pnpm was not found. Installing pnpm locally into .dev\pnpm.
call npm install --prefix "%PROJECT_PNPM_HOME%" pnpm@10.0.0 || exit /b 1
set "PATH=%PROJECT_PNPM_BIN%;%PATH%"
for /f "delims=" %%V in ('pnpm --version') do echo Installed project-local pnpm %%V
exit /b 0

:ensure_rust
if exist "%PROJECT_CARGO_HOME%\bin\cargo.exe" (
  set "CARGO_HOME=%PROJECT_CARGO_HOME%"
  set "RUSTUP_HOME=%PROJECT_RUSTUP_HOME%"
  set "PATH=%PROJECT_CARGO_HOME%\bin;%PATH%"
  for /f "delims=" %%V in ('cargo --version') do echo Using project-local %%V
  exit /b 0
)

where cargo >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%V in ('cargo --version') do echo Using installed %%V
  exit /b 0
)

echo Cargo was not found. Installing Rust locally into .dev\cargo and .dev\rustup.
set "CARGO_HOME=%PROJECT_CARGO_HOME%"
set "RUSTUP_HOME=%PROJECT_RUSTUP_HOME%"
set "PATH=%PROJECT_CARGO_HOME%\bin;%PATH%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; Invoke-WebRequest -Uri 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile $env:RUSTUP_INIT" || exit /b 1
"%RUSTUP_INIT%" -y --no-modify-path --default-toolchain stable --profile minimal || exit /b 1
rustup default stable || exit /b 1
for /f "delims=" %%V in ('cargo --version') do echo Installed project-local %%V
exit /b 0

:ensure_media_tools
set "INSTALLER_TOOLS_DIR=%PROJECT_TOOLS_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\prepare_installer_tools.ps1"
if errorlevel 1 exit /b 1
exit /b 0

:write_start_bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $text = Get-Content -Raw -LiteralPath $env:FIRST_SETUP; $marker = ':START_BAT_TEMPLATE'; $idx = $text.LastIndexOf($marker); if ($idx -lt 0) { throw 'Missing start.bat template.' }; $content = $text.Substring($idx + $marker.Length).TrimStart([char]13, [char]10); Set-Content -LiteralPath $env:START_BAT -Value $content -Encoding ASCII"
if errorlevel 1 exit /b 1
echo Wrote "%START_BAT%".
exit /b 0

:START_BAT_TEMPLATE
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
