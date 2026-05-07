#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$PROJECT_DIR/.dev"
PROJECT_NODE_DIR="$DEV_DIR/node"
PROJECT_PNPM_BIN="$DEV_DIR/pnpm/node_modules/.bin"
PROJECT_CARGO_HOME="$DEV_DIR/cargo"
PROJECT_RUSTUP_HOME="$DEV_DIR/rustup"
BACKEND_PORT=4777
BACKEND_PID=""

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
echo "Press Ctrl+C to stop the dev servers."
pnpm -C frontend dev
