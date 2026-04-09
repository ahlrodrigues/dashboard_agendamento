#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${DASHBOARD_BASE_DIR:-$SCRIPT_DIR}"
cd "$BASE_DIR"

LOG_FILE="${DASHBOARD_LOG_FILE:-$BASE_DIR/dashboard_server.log}"
PID_FILE="${DASHBOARD_PID_FILE:-$BASE_DIR/dashboard_server.pid}"
SERVER_SCRIPT="${DASHBOARD_SERVER_SCRIPT:-$BASE_DIR/server.js}"
NODE_BIN="${DASHBOARD_NODE_BIN:-node}"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" || true)"
  if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Encerrando servidor anterior (pid=${OLD_PID})" >> "$LOG_FILE"
    kill "$OLD_PID" || true
    sleep 2
  fi
  rm -f "$PID_FILE"
fi

STALE_PIDS="$(pgrep -f "$NODE_BIN $SERVER_SCRIPT" || true)"
if [[ -n "${STALE_PIDS:-}" ]]; then
  while IFS= read -r pid; do
    [[ -z "${pid:-}" ]] && continue
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Encerrando instancia antiga sem pid file (pid=${pid})" >> "$LOG_FILE"
    kill "$pid" || true
  done <<< "$STALE_PIDS"
  sleep 2
fi

bash "$BASE_DIR/garantir_dashboard_server.sh"
