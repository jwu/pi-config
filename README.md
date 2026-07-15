# Pi Config

一套用于 [Pi](https://github.com/badlogic/pi-mono) 的个人配置：提供自定义扩展、主题、Agent、Skill 和 Prompt，并以 Bun 管理开发与测试。

> 配置默认假定仓库位于 `~/bin/pi-config`，因为 [`settings.json`](settings.json) 使用了这个路径加载扩展。若放在其他位置，请相应修改该文件中的 `extensions` 路径。

## 特性

| 功能 | 内容 |
| --- | --- |
| 基础设置 | One Dark 主题、安静启动、Python 经由 `uv run` 转发，以及常用 package/tool 配置。 |
| 当前会话 Agent | [`custom-agent`](extensions/custom-agent.ts) 让 `pi --agent <name>` 在当前 session 加载 Markdown Agent，支持工具白名单、模型、思考等级、Skill 与 system prompt 模式。 |
| System Prompt 调试 | [`debug-system-prompt`](extensions/debug-system-prompt.ts) 会在外部编辑器中只读预览当前 session 的最终 system prompt。 |
| 模糊文件补全 | [`fuzzy-at`](extensions/fuzzy-at.ts) 为 `@` 文件引用提供跨路径的 fuzzy 匹配、命中高亮与长路径折叠。 |
| Ghostty 会话分屏 | [`ghostty-split`](extensions/ghostty-split.ts) 在 macOS Ghostty 中通过 `/split` 与 `/vsplit` 打开并加载当前 session 的分屏。 |
| 搜索结果增强 | [`grep-highlight`](extensions/grep-highlight.ts) 优化 `grep` 调用和搜索结果的 TUI 渲染。 |
| 文件阅读增强 | [`read`](extensions/read.ts) 优化 `read` 调用、代码高亮和折叠状态下的文件预览。 |
| 终端状态反馈 | [`terminal-signals`](extensions/terminal-signals.ts) 在 Agent 工作期间发送终端进度信号，并更新终端标签动画。 |
| 工作流资源 | 内置提交 Prompt、编码与 Neovim Skill，以及多种可复用 Agent。 |

## 前置条件

- 已安装并完成基本配置的 Pi。
- [Bun](https://bun.sh/)（用于安装依赖和运行检查）。
- 建议安装 `fd` 或 `ripgrep`，以获得更快的 `@` 文件补全；未安装时会自动回退至 `find`。
- 仅 [`ghostty-split`](extensions/ghostty-split.ts) 需要 macOS 和 [Ghostty](https://ghostty.org/)；其他配置不依赖它。

## 安装与同步

以下步骤会将仓库中的全局资源复制到 `~/.pi/agent`。执行前请备份已有的 `settings.json`，并按需合并你自己的认证、模型和其他个人设置。

```bash
# 1. 固定到 settings.json 所使用的位置
mkdir -p ~/bin
git clone git@github.com:jwu/pi-config.git ~/bin/pi-config
cd ~/bin/pi-config

# 2. 安装开发依赖
bun install

# 3. 备份并部署 Pi 资源
mkdir -p ~/.pi/agent/{agents,extensions,prompts,skills,themes}
[ -f ~/.pi/agent/settings.json ] && cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak
cp settings.json ~/.pi/agent/settings.json
cp -R agents/. ~/.pi/agent/agents/
cp -R extensions-settings/. ~/.pi/agent/extensions/
cp -R prompts/. ~/.pi/agent/prompts/
cp -R skills/. ~/.pi/agent/skills/
cp -R themes/. ~/.pi/agent/themes/
```

启动 Pi 后，`settings.json` 会从 `~/bin/pi-config/extensions` 加载本仓库的启用扩展，并按配置解析 package 扩展。更新仓库后，重新执行资源复制命令并在 Pi 内运行 `/reload`。

### 启用可选扩展

[`extensions-optional/auto-format.ts`](extensions-optional/auto-format.ts) 会在 `edit` 或 `write` 成功修改 TypeScript 文件后调用 Prettier。默认未启用；如需启用，将其目录加入 `~/.pi/agent/settings.json` 的 `extensions`：

```json
{
  "extensions": [
    "~/bin/pi-config/extensions",
    "~/bin/pi-config/extensions-optional"
  ]
}
```

保留原有 `settings.json` 的其他字段；不要直接用此片段覆盖整个文件。

## 使用

### 自定义 Agent

仓库中的 Agent 定义会部署到 `~/.pi/agent/agents/`。例如：

```bash
pi --agent coder
pi --agent scout
```

`coder` 是高思考等级的编码 Agent；`scout` 用于只读侦察。`debug-*` Agent 用于验证 system prompt 与 Skill 注入。Agent frontmatter 支持 `tools`、`model`、`thinking`、`skills`、`allowedAgents`、`systemPrompt` 等字段；完整规则见 [`docs/custom-agent.md`](docs/custom-agent.md)。

### 调试 System Prompt

在 Agent 会话中执行以下命令，可在外部编辑器中只读预览最终 system prompt：

```text
/debug-system-prompt
```

该命令会应用 `custom-agent` 的最终 prompt 注入结果，适合检查 `append`、`replace` 与 `replace-all` 模式，以及 Skill、工具和可用子 Agent 是否符合预期。请先设置 `$VISUAL` 或 `$EDITOR`；非交互模式不能使用此命令。

### `@` 模糊文件补全

在输入框中输入 `@` 加查询即可搜索项目文件。查询按子序列匹配完整路径：

```text
@mpafbar  →  my/path/foobar.md
@foobar/  →  path/to/foobar/
```

匹配项会使用当前主题的 accent 色高亮；含空格的路径会自动以引号形式补全。实现细节和限制见 [`docs/fuzzy-at.md`](docs/fuzzy-at.md)。

### read、grep 阅读增强

[`read`](extensions/read.ts) 和 [`grep-highlight`](extensions/grep-highlight.ts) 会自动接管 Pi 同名工具的 TUI 渲染，无需额外命令：

- `read`：保留代码语法高亮；在折叠状态下压缩显示文档、资源文件与 Skill 的内容，并为普通文件保留简短预览。
- `grep`：以路径、行号和匹配内容的不同颜色展示结果；折叠时默认显示前 15 行，并提示可展开查看余下输出和截断信息。

它们不改变工具的读取或搜索语义。`grep` 仅在 Pi 中启用该工具时生效；本仓库的 [`settings.json`](settings.json) 已将其加入工具列表。

### 终端状态信号

[`terminal-signals`](extensions/terminal-signals.ts) 自动在 Agent 开始工作时向终端发送进度信号，并在结束时清除进度、标记命令完成：

- 运行期间，终端标签显示 spinner 与当前工作目录。
- 空闲时，标签恢复为 `π - <目录名>`。
- 支持 OSC 进度信号的终端（如 Ghostty、WezTerm、iTerm2、Kitty、Windows Terminal 和 VS Code Terminal）会显示相应进度；不支持的终端会忽略这些信号，不影响使用。

### Ghostty 分屏

在已保存 session 的 Pi 中使用：

```text
/split   # 在下方创建分屏
/vsplit  # 在右侧创建分屏
```

新分屏会以同一 session 启动 Pi。该功能仅在 macOS 的 Ghostty 中可用。

### 提交 Prompt

使用 `/commit` 分析并按逻辑批次提交当前改动：

```text
/commit        # 展示方案后直接提交
/commit --ask  # 展示方案后等待确认
```

详细提交规则位于 [`prompts/commit.md`](prompts/commit.md)。

## 目录说明

```text
.
├── agents/                 # 可由 pi --agent 加载的 Markdown Agent
├── docs/                   # 扩展设计与使用说明
├── extensions/             # 默认启用的本地 Pi 扩展
├── extensions-optional/    # 按需启用的扩展
├── extensions-settings/    # package 扩展的全局配置文件
├── prompts/                # 斜杠命令 Prompt
├── skills/                 # 自定义 SKILL.md 与参考资料
├── tests/                  # 扩展单元测试
├── themes/                 # Pi 主题
├── deprecated/             # 已废弃的扩展，仅作保留
├── APPEND_SYSTEM.md        # 追加到 Pi system prompt 的规则
└── settings.json           # 推荐的全局 Pi 设置
```

## 本地开发

```bash
bun run format:check  # 检查扩展格式
bun run typecheck     # TypeScript 类型检查
bun test              # 运行全部测试
bun run lint          # 依次运行格式、类型和测试检查
```

修改扩展后可在 Pi 中执行 `/reload`，无需重启会话。提交前建议运行 `bun run lint`。

## 相关文档

- [`docs/custom-agent.md`](docs/custom-agent.md) — `custom-agent` 的 frontmatter、Skill 解析与 system prompt 注入模型。
- [`docs/fuzzy-at.md`](docs/fuzzy-at.md) — `@` fuzzy 补全的匹配、排序、展示和测试说明。
- [`docs/snacks-fuzzy-search.md`](docs/snacks-fuzzy-search.md) — Snacks.nvim fuzzy 搜索实现的调研笔记。
- [`skills/coding-guidelines/SKILL.md`](skills/coding-guidelines/SKILL.md) — 面向编码、审查与重构的行为指南。
