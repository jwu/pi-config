#!/bin/bash
set -euo pipefail

# ==========================================
# pi-config 部署脚本（已缩水）
# ==========================================
#
# 这里只保留 chezmoi 不负责的部分：settings.json。
#
# agents/、prompts/、skills/、themes/、keybindings.json、APPEND_SYSTEM.md、mcp.json 和
# extensions-settings/ 现在由 dotfiles 仓库的 chezmoi 源管理。再从这里复制一遍会和
# `chezmoi apply` 互相覆盖——两边都以为自己拥有同一批文件。
#
# extensions/ 本身不需要复制：settings.json 的 extensions 字段把它 live 加载进 pi。
# npm 插件也不需要在这里装：pi 首次启动时会按 settings.json 的 packages 列表自行安装。

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

mkdir -p "$AGENT_DIR"

# settings.json 保存认证、默认 provider 和模型等本机设置，默认不覆盖。
if [ -f "$AGENT_DIR/settings.json" ] && [ "$FORCE" -eq 0 ]; then
  echo ">>> Keeping existing $AGENT_DIR/settings.json (pass --force to overwrite)"
else
  backup_file "$AGENT_DIR/settings.json"
  cp "$SCRIPT_DIR/settings.json" "$AGENT_DIR/settings.json"
fi

# settings.json 用绝对路径指向这个仓库的 extensions/ 目录（pi 不展开 ~），所以仓库必须
# 待在预期位置，否则扩展加载不到。
EXPECTED_DIR="$HOME/bin/pi-config"
if [ "$SCRIPT_DIR" != "$EXPECTED_DIR" ]; then
  echo ">>> Warning: this repo is at $SCRIPT_DIR" >&2
  echo "    but settings.json points at $EXPECTED_DIR/extensions." >&2
  echo "    Move the repo to that path or update the extensions field." >&2
fi

echo ">>> Deployment Complete!"
echo "    Only settings.json was deployed."
echo "    agents/, prompts/, skills/, themes/, keybindings.json, APPEND_SYSTEM.md"
echo "    and mcp.json belong to the dotfiles chezmoi source now."
echo "    extensions/ is loaded live from $SCRIPT_DIR/extensions via settings.json."
echo "    Run /reload in Pi to apply changes."
