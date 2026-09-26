#!/bin/bash
set -euo pipefail

# ==========================================
# pi-config 路径检查（已无部署动作）
# ==========================================
#
# 这里不再部署任何文件。settings.json 与 mcp.json 已交给 dotfiles 仓库的 chezmoi，
# 作为 create_ 目标落地（private_dot_pi/private_agent/create_settings.json.tmpl 与
# create_mcp.json）：只在目标不存在时写一次，之后 pi 自己回写的内容不会被抹掉。
# 再从这里复制一遍就是两个所有者争同一份文件。
#
# extensions/ 本身不需要复制：settings.json 的 extensions 字段把它 live 加载进 pi。
# npm 插件也不需要在这里装：pi 首次启动时会按 settings.json 的 packages 列表自行安装。
#
# 保留这个脚本只是为了那条路径检查：chezmoi 渲染出的 extensions 指向
# ~/bin/pi-config/extensions，仓库换位置就加载不到扩展。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ">>> pi-config at $SCRIPT_DIR"
echo "    Nothing to deploy: settings.json and mcp.json are chezmoi create_ targets"
echo "    in the dotfiles repo now."

EXPECTED_DIR="$HOME/bin/pi-config"
if [ "$SCRIPT_DIR" != "$EXPECTED_DIR" ]; then
  echo ">>> Warning: this repo is at $SCRIPT_DIR" >&2
  echo "    but the deployed settings.json points at $EXPECTED_DIR/extensions." >&2
  echo "    Move the repo to that path, or update extensions in the dotfiles" >&2
  echo "    source and re-render it there." >&2
  exit 1
fi

echo ">>> Path check ok. Deploy settings with 'chezmoi apply' in dotfiles,"
echo "    then run /reload in pi."

exit 0
