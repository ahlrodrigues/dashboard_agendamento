#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${DASHBOARD_BASE_DIR:-/var/www/html/dashboard_agendamento-live}"
cd "$BASE_DIR"

LOG_FILE="${DASHBOARD_LOG_FILE:-$BASE_DIR/dashboard_server.log}"
PID_FILE="${DASHBOARD_PID_FILE:-$BASE_DIR/dashboard_server.pid}"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" || true)"
  if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Encerrando servidor anterior (pid=${OLD_PID})" >> "$LOG_FILE"
    kill "$OLD_PID" || true
    sleep 2
  fi
  rm -f "$PID_FILE"
fi

bash "$BASE_DIR/garantir_dashboard_server.sh"
