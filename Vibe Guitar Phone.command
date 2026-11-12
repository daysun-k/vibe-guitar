#!/bin/bash
# Vibe Guitar phone music stand (휴대폰 악보대): double-click in Finder to start the relay.
# Same as `npm run phone` in this folder. Extra arguments are passed through (e.g. --idle-minutes 20).
# Installs nothing, needs no sudo, and only starts the local relay.

cd "$(dirname "$0")" || exit 1

pause_on_error() {
  # Keep the window readable when started from Finder; never wait when run from a script.
  if [ -t 0 ]; then
    echo ""
    read -r -p "Enter 키를 누르면 이 창이 닫힙니다. " _
  fi
}

# Finder starts .command files with a short PATH; look where Node is usually installed.
if ! command -v node >/dev/null 2>&1; then
  for dir in /opt/homebrew/bin /usr/local/bin; do
    [ -x "$dir/node" ] && PATH="$dir:$PATH"
  done
fi
if ! command -v node >/dev/null 2>&1; then
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  default_alias=""
  [ -f "$NVM_DIR/alias/default" ] && default_alias="$(cat "$NVM_DIR/alias/default")"
  for candidate in "$NVM_DIR/versions/node/$default_alias" "$NVM_DIR/versions/node/v$default_alias"*; do
    if [ -n "$default_alias" ] && [ -x "$candidate/bin/node" ]; then
      PATH="$candidate/bin:$PATH"
      break
    fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  # Last resort: the newest nvm-installed Node.
  newest="$(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin 2>/dev/null | sort -V | tail -n 1)"
  [ -n "$newest" ] && [ -x "$newest/node" ] && PATH="$newest:$PATH"
fi
export PATH

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js를 찾지 못했습니다."
  echo "휴대폰 악보대는 Node.js로 실행됩니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 이 파일을 다시 더블클릭해 주세요."
  echo "(찾아본 곳: 현재 PATH, /opt/homebrew/bin, /usr/local/bin, ~/.nvm)"
  pause_on_error
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ -z "$node_major" ] || [ "$node_major" -lt 20 ]; then
  echo "Node.js $(node -v 2>/dev/null)는 너무 오래된 버전입니다. 20 이상이 필요합니다 ($(command -v node))."
  pause_on_error
  exit 1
fi

if [ ! -d node_modules/esbuild ]; then
  echo "이 폴더에 필요한 개발 도구가 아직 설치되지 않았습니다."
  echo "터미널에서 한 번만 다음을 실행한 뒤 다시 더블클릭해 주세요:"
  echo "  cd \"$(pwd)\" && npm ci"
  pause_on_error
  exit 1
fi

echo "Vibe Guitar 휴대폰 악보대를 준비하는 중입니다… ($(pwd))"

# Foreground, so the QR code and messages stay in this window. Ctrl+C or closing the window stops it.
node scripts/phone.mjs "$@"
status=$?

echo ""
case $status in
  0) echo "중계기가 꺼졌습니다. 이 창은 닫아도 됩니다." ;;
  3) pause_on_error ;;
  130) echo "중계기가 꺼졌습니다." ;;
  *) echo "중계기가 오류로 멈췄습니다 (종료 코드 $status). 위의 메시지를 확인해 주세요."; pause_on_error ;;
esac
exit $status
