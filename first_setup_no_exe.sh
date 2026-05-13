#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$PROJECT_DIR/.dev"
PROJECT_TOOLS_DIR="$PROJECT_DIR/tools"
PROJECT_NODE_DIR="$DEV_DIR/node"
PROJECT_PNPM_HOME="$DEV_DIR/pnpm"
PROJECT_PNPM_BIN="$PROJECT_PNPM_HOME/node_modules/.bin"
PROJECT_CARGO_HOME="$DEV_DIR/cargo"
PROJECT_RUSTUP_HOME="$DEV_DIR/rustup"
START_SCRIPT="$PROJECT_DIR/start_no_exe.sh"

SKIP_INSTALL=0
SKIP_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

cd "$PROJECT_DIR"

update_source_checkout() {
  if [[ ! -d "$PROJECT_DIR/.git" ]]; then
    return 0
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "Git was not found. Skipping source update." >&2
    return 0
  fi
  if ! git diff --quiet -- . || ! git diff --cached --quiet -- .; then
    echo "Local tracked changes are present. Skipping git pull to avoid overwriting edits." >&2
    return 0
  fi
  echo "Checking for source updates from git..."
  git pull --ff-only
}

update_source_checkout
mkdir -p "$DEV_DIR"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required for local bootstrap." >&2
    exit 1
  fi
}

ensure_node() {
  echo
  echo "== Checking Node.js =="
  if [[ -x "$PROJECT_NODE_DIR/bin/node" ]]; then
    export PATH="$PROJECT_NODE_DIR/bin:$PATH"
    echo "Using project-local Node.js $(node --version)"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    echo "Using installed Node.js $(node --version)"
    return
  fi

  need_cmd curl
  need_cmd tar

  local os arch node_arch platform version archive extract_dir
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) node_arch="x64" ;;
    arm64|aarch64) node_arch="arm64" ;;
    *) echo "Unsupported CPU architecture for Node.js bootstrap: $arch" >&2; exit 1 ;;
  esac

  case "$os" in
    Darwin) platform="darwin-$node_arch" ;;
    Linux) platform="linux-$node_arch" ;;
    *) echo "Unsupported OS for Node.js bootstrap: $os" >&2; exit 1 ;;
  esac

  echo "Node.js was not found. Installing latest LTS Node.js into .dev/node."
  version="$(curl -fsSL https://nodejs.org/dist/index.json | grep -m 1 '"lts":"' | sed -E 's/.*"version":"([^"]+)".*/\1/')"
  if [[ -z "$version" || "$version" == "["* ]]; then
    echo "Could not resolve latest Node.js LTS version." >&2
    exit 1
  fi

  archive="$DEV_DIR/node.tar.xz"
  extract_dir="$DEV_DIR/node-extract"
  rm -rf "$PROJECT_NODE_DIR" "$extract_dir" "$archive"
  mkdir -p "$extract_dir"
  curl -fsSL "https://nodejs.org/dist/$version/node-$version-$platform.tar.xz" -o "$archive"
  tar -xJf "$archive" -C "$extract_dir"
  mv "$extract_dir/node-$version-$platform" "$PROJECT_NODE_DIR"
  rm -rf "$archive" "$extract_dir"
  export PATH="$PROJECT_NODE_DIR/bin:$PATH"
  echo "Installed project-local Node.js $(node --version)"
}

ensure_pnpm() {
  echo
  echo "== Checking pnpm =="
  if [[ -x "$PROJECT_PNPM_BIN/pnpm" ]]; then
    export PATH="$PROJECT_PNPM_BIN:$PATH"
    echo "Using project-local pnpm $(pnpm --version)"
    return
  fi

  if command -v pnpm >/dev/null 2>&1; then
    echo "Using installed pnpm $(pnpm --version)"
    return
  fi

  echo "pnpm was not found. Installing pnpm locally into .dev/pnpm."
  npm install --prefix "$PROJECT_PNPM_HOME" pnpm@10.0.0
  export PATH="$PROJECT_PNPM_BIN:$PATH"
  echo "Installed project-local pnpm $(pnpm --version)"
}

ensure_rust() {
  echo
  echo "== Checking Rust/Cargo =="
  if [[ -x "$PROJECT_CARGO_HOME/bin/cargo" ]]; then
    export CARGO_HOME="$PROJECT_CARGO_HOME"
    export RUSTUP_HOME="$PROJECT_RUSTUP_HOME"
    export PATH="$PROJECT_CARGO_HOME/bin:$PATH"
    echo "Using project-local $(cargo --version)"
    return
  fi

  if command -v cargo >/dev/null 2>&1; then
    echo "Using installed $(cargo --version)"
    return
  fi

  need_cmd curl
  echo "Cargo was not found. Installing Rust locally into .dev/cargo and .dev/rustup."
  export CARGO_HOME="$PROJECT_CARGO_HOME"
  export RUSTUP_HOME="$PROJECT_RUSTUP_HOME"
  export PATH="$PROJECT_CARGO_HOME/bin:$PATH"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain stable --profile minimal
  rustup default stable
  echo "Installed project-local $(cargo --version)"
}

ensure_media_tools() {
  echo
  echo "== Preparing media helper tools =="
  mkdir -p "$PROJECT_TOOLS_DIR"
  ensure_yt_dlp_tool
  ensure_ffmpeg_tools
  echo "Media helper tools are ready in $PROJECT_TOOLS_DIR."
}

ensure_yt_dlp_tool() {
  local target os arch asset
  target="$PROJECT_TOOLS_DIR/yt-dlp"
  if [[ -x "$target" ]]; then
    echo "Using project-local yt-dlp."
    return
  fi

  need_cmd curl
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os:$arch" in
    Darwin:*) asset="yt-dlp_macos" ;;
    Linux:x86_64|Linux:amd64) asset="yt-dlp_linux" ;;
    Linux:arm64|Linux:aarch64) asset="yt-dlp_linux_aarch64" ;;
    *) echo "Unsupported platform for yt-dlp bootstrap: $os $arch" >&2; exit 1 ;;
  esac

  echo "Downloading yt-dlp into tools/."
  curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$asset" -o "$target"
  chmod +x "$target"
}

ensure_ffmpeg_tools() {
  if [[ -x "$PROJECT_TOOLS_DIR/ffmpeg" && -x "$PROJECT_TOOLS_DIR/ffprobe" ]]; then
    echo "Using project-local ffmpeg and ffprobe."
    return
  fi

  need_cmd curl
  local os
  os="$(uname -s)"
  case "$os" in
    Darwin) download_macos_ffmpeg_tools ;;
    Linux) download_linux_ffmpeg_tools ;;
    *) echo "Unsupported OS for ffmpeg bootstrap: $os" >&2; exit 1 ;;
  esac

  chmod +x "$PROJECT_TOOLS_DIR/ffmpeg" "$PROJECT_TOOLS_DIR/ffprobe"
}

download_linux_ffmpeg_tools() {
  need_cmd tar
  local arch asset archive extract_dir ffmpeg_source ffprobe_source
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) asset="ffmpeg-master-latest-linux64-lgpl.tar.xz" ;;
    arm64|aarch64) asset="ffmpeg-master-latest-linuxarm64-lgpl.tar.xz" ;;
    *) echo "Unsupported CPU architecture for FFmpeg bootstrap: $arch" >&2; exit 1 ;;
  esac

  archive="$DEV_DIR/helper-cache/$asset"
  extract_dir="$DEV_DIR/helper-cache/ffmpeg"
  rm -rf "$extract_dir"
  mkdir -p "$extract_dir" "$(dirname "$archive")"

  echo "Downloading FFmpeg LGPL build into tools/."
  curl -fL "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$asset" -o "$archive"
  tar -xJf "$archive" -C "$extract_dir"

  ffmpeg_source="$(find "$extract_dir" -type f -name ffmpeg | head -n 1)"
  ffprobe_source="$(find "$extract_dir" -type f -name ffprobe | head -n 1)"
  if [[ -z "$ffmpeg_source" || -z "$ffprobe_source" ]]; then
    echo "FFmpeg archive did not contain ffmpeg and ffprobe." >&2
    exit 1
  fi

  cp "$ffmpeg_source" "$PROJECT_TOOLS_DIR/ffmpeg"
  cp "$ffprobe_source" "$PROJECT_TOOLS_DIR/ffprobe"
}

download_macos_ffmpeg_tools() {
  need_cmd unzip
  local cache ffmpeg_zip ffprobe_zip
  cache="$DEV_DIR/helper-cache/macos-ffmpeg"
  ffmpeg_zip="$cache/ffmpeg.zip"
  ffprobe_zip="$cache/ffprobe.zip"
  rm -rf "$cache"
  mkdir -p "$cache"

  echo "Downloading FFmpeg tools into tools/."
  curl -fL 'https://evermeet.cx/ffmpeg/getrelease/zip' -o "$ffmpeg_zip"
  curl -fL 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip' -o "$ffprobe_zip"
  unzip -oq "$ffmpeg_zip" -d "$cache/ffmpeg"
  unzip -oq "$ffprobe_zip" -d "$cache/ffprobe"

  if [[ ! -f "$cache/ffmpeg/ffmpeg" || ! -f "$cache/ffprobe/ffprobe" ]]; then
    echo "Downloaded FFmpeg archives did not contain ffmpeg and ffprobe." >&2
    exit 1
  fi

  cp "$cache/ffmpeg/ffmpeg" "$PROJECT_TOOLS_DIR/ffmpeg"
  cp "$cache/ffprobe/ffprobe" "$PROJECT_TOOLS_DIR/ffprobe"
}

write_start_script() {
  echo
  echo "== Creating start_no_exe.sh =="
  cat > "$START_SCRIPT" <<'START_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$PROJECT_DIR/.dev"
PROJECT_NODE_DIR="$DEV_DIR/node"
PROJECT_PNPM_BIN="$DEV_DIR/pnpm/node_modules/.bin"
PROJECT_CARGO_HOME="$DEV_DIR/cargo"
PROJECT_RUSTUP_HOME="$DEV_DIR/rustup"
BACKEND_PORT="${POLYSONG_BACKEND_PORT:-4778}"
BACKEND_PID=""
export POLYSONG_DATA_DIR="$PROJECT_DIR"
export POLYSONG_BACKEND_PORT="$BACKEND_PORT"
export VITE_POLYSONG_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT"

if [[ -x "$PROJECT_NODE_DIR/bin/node" ]]; then
  export PATH="$PROJECT_NODE_DIR/bin:$PATH"
fi
if [[ -x "$PROJECT_PNPM_BIN/pnpm" ]]; then
  export PATH="$PROJECT_PNPM_BIN:$PATH"
fi
if [[ -x "$PROJECT_CARGO_HOME/bin/cargo" ]]; then
  export CARGO_HOME="$PROJECT_CARGO_HOME"
  export RUSTUP_HOME="$PROJECT_RUSTUP_HOME"
  export PATH="$PROJECT_CARGO_HOME/bin:$PATH"
fi

cd "$PROJECT_DIR"

update_source_checkout() {
  if [[ ! -d "$PROJECT_DIR/.git" ]]; then
    return 0
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "Git was not found. Skipping source update." >&2
    return 0
  fi
  if ! git diff --quiet -- . || ! git diff --cached --quiet -- .; then
    echo "Local tracked changes are present. Skipping git pull to avoid overwriting edits." >&2
    return 0
  fi
  echo "Checking for source updates from git..."
  git pull --ff-only
}

update_source_checkout

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm was not found. Run ./first_setup_no_exe.sh first." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Cargo was not found. Run ./first_setup_no_exe.sh first." >&2
  exit 1
fi

if [[ ! -d "$PROJECT_DIR/frontend/node_modules" ]]; then
  echo "Frontend dependencies are missing. Run ./first_setup_no_exe.sh first." >&2
  exit 1
fi

find_port_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$BACKEND_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$BACKEND_PORT" 2>/dev/null | sed -nE 's/.*pid=([0-9]+).*/\1/p' | head -n 1
  fi
}

stop_stale_backend() {
  local pid command_line
  pid="$(find_port_pid || true)"
  [[ -z "$pid" ]] && return

  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command_line" == *"polysong-app"* || "$command_line" == *"cargo run --package polysong-app"* ]]; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    return
  fi

  echo "Port $BACKEND_PORT is already in use by PID $pid: $command_line" >&2
  exit 1
}

open_browser() {
  local url="http://localhost:5173"
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

mkdir -p "$DEV_DIR"
stop_stale_backend
: > "$DEV_DIR/backend.log"
: > "$DEV_DIR/backend.err.log"

cargo run --package polysong-app -- --backend-server > "$DEV_DIR/backend.log" 2> "$DEV_DIR/backend.err.log" &
BACKEND_PID="$!"

sleep 2
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "Polysong backend failed to start." >&2
  cat "$DEV_DIR/backend.err.log" >&2 || true
  exit 1
fi

open_browser
echo "Starting Polysong backend and browser frontend."
echo "Data directory: $POLYSONG_DATA_DIR"
echo "Backend URL: $VITE_POLYSONG_BACKEND_URL"
echo "Press Ctrl+C to stop the dev servers."
pnpm -C frontend dev
START_SCRIPT
  chmod +x "$START_SCRIPT"
  echo "Wrote $START_SCRIPT."
}

ensure_node
ensure_pnpm
ensure_rust

echo
echo "== Installing project dependencies =="
if [[ "$SKIP_INSTALL" == "1" ]]; then
  echo "Skipped dependency install because --skip-install was passed."
else
  pnpm install
  pnpm -C frontend install
fi

echo
echo "== Checking Tauri CLI =="
if [[ ! -x "$PROJECT_DIR/frontend/node_modules/.bin/tauri" ]]; then
  echo "Tauri CLI was not found in frontend dependencies. Installing it locally."
  pnpm -C frontend add -D '@tauri-apps/cli@^2.9.3'
fi
pnpm -C frontend exec tauri --version

ensure_media_tools

write_start_script

echo
echo "== Building project =="
if [[ "$SKIP_BUILD" == "1" ]]; then
  echo "Skipped build because --skip-build was passed."
else
  pnpm -C frontend build
  cargo build --workspace
fi

echo
echo "Setup complete. Run ./start_no_exe.sh to start the browser frontend and backend."
