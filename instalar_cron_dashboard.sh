#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$BASE_DIR/config.json"
SCRIPT_FILE="$BASE_DIR/garantir_dashboard_server.sh"
INTERVALO_MINUTOS=5

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "config.json nao encontrado em $BASE_DIR" >&2
  exit 1
fi

if [[ ! -x "$SCRIPT_FILE" ]]; then
  chmod +x "$SCRIPT_FILE"
fi

if ! command -v crontab >/dev/null 2>&1; then
  echo "crontab nao encontrado neste sistema." >&2
  exit 1
fi

CRON_TAG="# dashboard_agendamento_auto_start"
CRON_CMD="*/${INTERVALO_MINUTOS} * * * * /bin/bash \"$SCRIPT_FILE\" $CRON_TAG"

TMP_CRON="$(mktemp)"
trap 'rm -f "$TMP_CRON"' EXIT

crontab -l 2>/dev/null | grep -v "$CRON_TAG" > "$TMP_CRON" || true
echo "$CRON_CMD" >> "$TMP_CRON"
crontab "$TMP_CRON"

echo "Cron instalado com sucesso para executar a cada ${INTERVALO_MINUTOS} minuto(s)."
