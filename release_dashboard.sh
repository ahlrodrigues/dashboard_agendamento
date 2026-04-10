#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

NODE_BIN="${NODE_BIN:-node}"

usage() {
  cat <<'EOF'
Uso:
  ./release_dashboard.sh patch
  ./release_dashboard.sh minor --push
  ./release_dashboard.sh major --message "Sua mensagem"
  ./release_dashboard.sh patch --push --message "Sua mensagem"

Opcoes:
  patch|minor|major   Tipo de incremento semantico
  --push              Envia o commit para o remoto apos concluir
  --message TEXTO     Sobrescreve a mensagem gerada automaticamente
EOF
}

require_clean_index() {
  if ! git diff --quiet --cached; then
    echo "Ha alteracoes ja staged. Conclua ou limpe o staging antes de usar o release_dashboard.sh."
    exit 1
  fi
}

current_branch() {
  git branch --show-current
}

fetch_remote_state() {
  git fetch --prune origin
}

ensure_branch_tracks_remote() {
  local branch="$1"
  if ! git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    echo "A branch origin/$branch nao foi encontrada. Crie a branch remota ou configure o tracking antes de usar o release_dashboard.sh."
    exit 1
  fi
}

ensure_branch_up_to_date() {
  local branch="$1"
  local local_sha remote_sha base_sha

  local_sha="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse "origin/$branch")"
  base_sha="$(git merge-base HEAD "origin/$branch")"

  if [[ "$local_sha" == "$remote_sha" ]]; then
    return
  fi

  if [[ "$local_sha" == "$base_sha" ]]; then
    echo "A branch local $branch esta atras de origin/$branch. Atualize com merge/rebase antes de gerar um release."
    exit 1
  fi

  if [[ "$remote_sha" == "$base_sha" ]]; then
    echo "A branch local $branch tem commits nao enviados. O release pode prosseguir, mas faca isso conscientemente."
    return
  fi

  echo "A branch local $branch divergiu de origin/$branch. Resolva a divergencia antes de gerar um release."
  exit 1
}

collect_changed_files() {
  git status --short --untracked-files=all | awk '{print $2}'
}

join_with_and() {
  local items=("$@")
  local count="${#items[@]}"
  if (( count == 0 )); then
    printf '%s' ""
    return
  fi
  if (( count == 1 )); then
    printf '%s' "${items[0]}"
    return
  fi
  if (( count == 2 )); then
    printf '%s and %s' "${items[0]}" "${items[1]}"
    return
  fi

  local result=""
  local i
  for (( i=0; i<count; i++ )); do
    if (( i == count - 1 )); then
      result+="and ${items[i]}"
    else
      result+="${items[i]}, "
    fi
  done
  printf '%s' "$result"
}

append_part() {
  local value="$1"
  if [[ -z "$value" ]]; then
    return
  fi
  MESSAGE_PARTS+=("$value")
}

generate_commit_message() {
  local changed_files_text="$1"
  MESSAGE_PARTS=()

  if grep -Eq '(^|/)server\.js$' <<<"$changed_files_text"; then
    append_part "backend"
  fi
  if grep -Eq '(^|/)public/' <<<"$changed_files_text"; then
    append_part "frontend"
  fi
  if grep -Eq '(^|/)(atualizar_live\.sh|garantir_dashboard_server\.sh|reiniciar_dashboard_server\.sh|instalar_cron_dashboard\.sh|release_dashboard\.sh|bump_version\.js)$' <<<"$changed_files_text"; then
    append_part "deploy tooling"
  fi
  if grep -Eq '(^|/)(README\.md|config\.example\.json|CHANGELOG\.md)$' <<<"$changed_files_text"; then
    append_part "project docs"
  fi

  local joined
  joined="$(join_with_and "${MESSAGE_PARTS[@]}")"
  if [[ -z "$joined" ]]; then
    echo "Update project files"
    return
  fi

  echo "Update $joined"
}

TYPE="${1:-}"
if [[ -z "$TYPE" ]]; then
  usage
  exit 1
fi
shift

case "$TYPE" in
  patch|minor|major) ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    echo "Tipo invalido: $TYPE"
    usage
    exit 1
    ;;
esac

PUSH=false
CUSTOM_MESSAGE=""

while (( "$#" )); do
  case "$1" in
    --push)
      PUSH=true
      shift
      ;;
    --message)
      if (( "$#" < 2 )); then
        echo "A opcao --message exige um texto."
        exit 1
      fi
      CUSTOM_MESSAGE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Opcao invalida: $1"
      usage
      exit 1
      ;;
  esac
done

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "Nao encontrei o Node ($NODE_BIN)."
  exit 1
fi

require_clean_index
BRANCH="$(current_branch)"
if [[ -z "$BRANCH" ]]; then
  echo "Nao foi possivel identificar a branch atual."
  exit 1
fi
fetch_remote_state
ensure_branch_tracks_remote "$BRANCH"
ensure_branch_up_to_date "$BRANCH"

CHANGED_FILES="$(collect_changed_files)"
if [[ -z "$CHANGED_FILES" ]]; then
  echo "Nao ha alteracoes para versionar."
  exit 1
fi

COMMIT_MESSAGE="$CUSTOM_MESSAGE"
if [[ -z "$COMMIT_MESSAGE" ]]; then
  COMMIT_MESSAGE="$(generate_commit_message "$CHANGED_FILES")"
fi

NEW_VERSION="$("$NODE_BIN" bump_version.js "$TYPE")"
echo "Versao atualizada para $NEW_VERSION"

git add -A
git commit -m "$COMMIT_MESSAGE"

if [[ "$PUSH" == true ]]; then
  fetch_remote_state
  ensure_branch_tracks_remote "$BRANCH"
  ensure_branch_up_to_date "$BRANCH"
  git push
fi

echo "Release concluido."
echo "Versao: $NEW_VERSION"
echo "Commit: $(git rev-parse --short HEAD)"
echo "Mensagem: $COMMIT_MESSAGE"

