#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${DASHBOARD_BASE_DIR:-$SCRIPT_DIR}"
cd "$BASE_DIR"

MODE="${DASHBOARD_MODE:-}"
if [[ -z "${MODE:-}" ]]; then
  if [[ "$(id -u)" == "0" ]]; then
    MODE="remoto"
  else
    MODE="local"
  fi
fi

case "$MODE" in
  local)
    exec bash "$BASE_DIR/reiniciar_dashboard_server.local.sh"
    ;;
  remoto|remote)
    exec bash "$BASE_DIR/reiniciar_dashboard_server.remoto.sh"
    ;;
  *)
    echo "Modo invalido em DASHBOARD_MODE='$MODE' (use 'local' ou 'remoto')." >&2
    exit 2
    ;;
esac
