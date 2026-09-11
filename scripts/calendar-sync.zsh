#!/bin/zsh
set -euo pipefail
export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin
lock_dir="$HOME/.config/openstride/calendar-sync.lock"
mkdir -p "$HOME/.config/openstride"
if ! mkdir "$lock_dir" 2>/dev/null; then
  print -u2 'Calendar sync lock exists; verify the earlier process before removing it.'
  exit 1
fi
trap 'rmdir "$lock_dir"' EXIT
source "$HOME/.config/gogcli/agent-env.zsh"
/opt/homebrew/bin/node "$HOME/tools/openstride/calendar-bridge.mjs" "$HOME/.config/openstride/calendar-bridge.json"
