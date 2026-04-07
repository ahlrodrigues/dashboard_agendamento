#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BASE_DIR"

BRANCH="${DEPLOY_BRANCH:-main}"
REMOTE_NAME="${DEPLOY_REMOTE_NAME:-origin}"
REMOTE_HOST="${DEPLOY_REMOTE_HOST:-samba}"
REMOTE_USER="${DEPLOY_REMOTE_USER:-root}"
REMOTE_BASE_DIR="${DEPLOY_REMOTE_BASE_DIR:-/var/www/html/dashboard_agendamento-live}"
REMOTE_NODE_BIN="${DEPLOY_REMOTE_NODE_BIN:-/usr/bin/node}"
COMMIT_MESSAGE="${1:-}"

build_auto_commit_message() {
  local changed_files="$1"
  local has_backend=0
  local has_interface=0
  local has_deploy=0
  local has_config=0

  if grep -qx 'server.js' <<<"$changed_files"; then
    has_backend=1
  fi

  if grep -q '^public/' <<<"$changed_files"; then
    has_interface=1
  fi

  if grep -Eq '(^|/).+\.sh$|^deploy\.sh$' <<<"$changed_files"; then
    has_deploy=1
  fi

  if grep -qx 'config.example.json' <<<"$changed_files"; then
    has_config=1
  fi

  if [[ "$has_backend" -eq 1 && "$has_interface" -eq 1 && "$has_deploy" -eq 1 ]]; then
    echo "Ajusta dashboard e scripts de deploy"
    return
  fi

  if [[ "$has_backend" -eq 1 && "$has_interface" -eq 1 ]]; then
    echo "Ajusta backend e interface do dashboard"
    return
  fi

  if [[ "$has_backend" -eq 1 && "$has_deploy" -eq 1 ]]; then
    echo "Ajusta backend e scripts de deploy"
    return
  fi

  if [[ "$has_interface" -eq 1 && "$has_deploy" -eq 1 ]]; then
    echo "Ajusta interface e scripts de deploy"
    return
  fi

  if [[ "$has_backend" -eq 1 ]]; then
    echo "Ajusta backend do dashboard"
    return
  fi

  if [[ "$has_interface" -eq 1 ]]; then
    echo "Ajusta interface do dashboard"
    return
  fi

  if [[ "$has_deploy" -eq 1 ]]; then
    echo "Ajusta scripts de deploy"
    return
  fi

  if [[ "$has_config" -eq 1 ]]; then
    echo "Ajusta configuracao de exemplo do dashboard"
    return
  fi

  echo "Atualiza dashboard_agendamento"
}

if [[ -z "$(git status --porcelain)" ]]; then
  echo "Nenhuma alteracao local para commit."
else
  git add .gitignore config.example.json public/app.js public/index.html public/styles.css server.js \
    atualizar_live.sh garantir_dashboard_server.sh reiniciar_dashboard_server.sh deploy.sh

  if ! git diff --cached --quiet; then
    if [[ -z "$COMMIT_MESSAGE" ]]; then
      COMMIT_MESSAGE="$(build_auto_commit_message "$(git diff --cached --name-only)")"
    fi
    git commit -m "$COMMIT_MESSAGE"
  else
    echo "Nenhuma alteracao rastreada para commit."
  fi
fi

git push "$REMOTE_NAME" "$BRANCH"

ssh "${REMOTE_USER}@${REMOTE_HOST}" \
  "cd '${REMOTE_BASE_DIR}' && DASHBOARD_NODE_BIN='${REMOTE_NODE_BIN}' bash ./atualizar_live.sh '${BRANCH}'"
