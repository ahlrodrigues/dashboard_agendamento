#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${DASHBOARD_BASE_DIR:-$SCRIPT_DIR}"
cd "$BASE_DIR"

HOST="${DASHBOARD_SERVER_HOST:-127.0.0.1}"
PORT="${DASHBOARD_SERVER_PORT:-8780}"
CHECK_HOST="${DASHBOARD_SERVER_CHECK_HOST:-127.0.0.1}"
NODE_BIN="${DASHBOARD_NODE_BIN:-}"
SERVER_SCRIPT="${DASHBOARD_SERVER_SCRIPT:-$BASE_DIR/server.js}"
LOG_FILE="${DASHBOARD_LOG_FILE:-$BASE_DIR/dashboard_server.log}"
PID_FILE="${DASHBOARD_PID_FILE:-$BASE_DIR/dashboard_server.pid}"

if [[ -z "$NODE_BIN" ]]; then
  for candidate in "$(command -v node 2>/dev/null || true)" /usr/bin/node /usr/local/bin/node /bin/node; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Node nao encontrado." >&2
  exit 1
fi

if [[ ! -f "$SERVER_SCRIPT" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Arquivo do servidor nao encontrado em $SERVER_SCRIPT" >&2
  exit 1
fi

port_is_active() {
  "$NODE_BIN" -e '
    const net = require("net");
    const host = process.argv[1];
    const port = Number(process.argv[2]);
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1500);
    socket.on("connect", () => { console.log("1"); socket.destroy(); });
    socket.on("timeout", () => { console.log("0"); socket.destroy(); });
    socket.on("error", () => { console.log("0"); });
  ' "$CHECK_HOST" "$PORT"
}

if [[ "$(port_is_active)" == "1" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Servidor ja esta ativo em ${CHECK_HOST}:${PORT}" >> "$LOG_FILE"
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando servidor em ${HOST}:${PORT}" >> "$LOG_FILE"
setsid env HOST="$HOST" PORT="$PORT" "$NODE_BIN" "$SERVER_SCRIPT" >> "$LOG_FILE" 2>&1 < /dev/null &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

sleep 2

if [[ "$(port_is_active)" != "1" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Falha ao iniciar servidor em ${CHECK_HOST}:${PORT}" >> "$LOG_FILE"
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Servidor iniciado com sucesso (pid=${SERVER_PID})" >> "$LOG_FILE"
