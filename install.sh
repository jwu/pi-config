#!/bin/bash
set -euo pipefail

# ==========================================
# Configuration and Paths
# ==========================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

echo ">>> Deploying pi-config to $AGENT_DIR"
echo "    Source dir: $SCRIPT_DIR"

# ==========================================
# Helpers
# ==========================================

backup_file() {
  if [ -f "$1" ]; then
    echo ">>> Backing up $1 to $1.bak.$TIMESTAMP"
    cp "$1" "$1.bak.$TIMESTAMP"
  fi
}

# ==========================================
# Copy Configurations
# ==========================================

mkdir -p "$AGENT_DIR/agents" "$AGENT_DIR/extensions" "$AGENT_DIR/prompts" "$AGENT_DIR/skills" "$AGENT_DIR/themes"

# settings.json 保存认证、默认 provider 和模型等本机设置，默认不覆盖。
if [ -f "$AGENT_DIR/settings.json" ] && [ "$FORCE" -eq 0 ]; then
  echo ">>> Keeping existing $AGENT_DIR/settings.json (pass --force to overwrite)"
else
  backup_file "$AGENT_DIR/settings.json"
  cp "$SCRIPT_DIR/settings.json" "$AGENT_DIR/settings.json"
fi

backup_file "$AGENT_DIR/keybindings.json"
cp "$SCRIPT_DIR/keybindings.json" "$AGENT_DIR/keybindings.json"

echo ">>> Copying agents, prompts, skills, themes and extension settings..."
cp -R "$SCRIPT_DIR/agents/." "$AGENT_DIR/agents/"
cp -R "$SCRIPT_DIR/prompts/." "$AGENT_DIR/prompts/"
cp -R "$SCRIPT_DIR/skills/." "$AGENT_DIR/skills/"
cp -R "$SCRIPT_DIR/themes/." "$AGENT_DIR/themes/"
cp -R "$SCRIPT_DIR/extensions-settings/." "$AGENT_DIR/extensions/"

echo ">>> Deployment Complete!"
echo "    extensions/ is loaded live from $SCRIPT_DIR/extensions via settings.json."
echo "    Run /reload in Pi to apply changes."
