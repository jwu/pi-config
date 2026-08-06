# custom-agent

`extensions/custom-agent.ts` 的定位是：用 `pi-subagents` 的 Markdown agent frontmatter 解析逻辑和 system prompt 注入方案，来启动当前 `pi --agent <name>` session。

它不是 `pi-subagents` 的替代品，也不会 spawn 子 pi 进程。`pi-subagents` 负责通过 `subagent` tool 启动隔离子进程；`custom-agent` 负责把一个 Markdown agent 应用到当前 pi 进程。

## Source of truth

后续移植功能时优先对照这些文件：

- `~/dev/jwu/pi-subagents/extensions/agent-loader.ts`
  - agent frontmatter 字段、默认值、校验规则
- `~/dev/jwu/pi-subagents/extensions/skill-resolver.ts`
  - skills 搜索路径、wildcard、warnings、symlink skill dir
- `~/dev/jwu/pi-subagents/extensions/subagent-executor.ts`
  - skills 注入格式、replace/append prompt 文件生成
- `~/dev/jwu/pi-subagents/extensions/subagent-prompt.ts`
  - `Available tools` / `Guidelines` 的运行时占位符注入格式

## Agent file format

Agent 文件来自：

1. global: `~/.pi/agent/agents/*.md`
2. project: `<cwd>/.pi/agents/*.md`

project agent 覆盖同名 global agent。

示例：

```md
---
name: debug-subagent-replace
description: 用于调试 subagent 的 system prompt
tools: read, subagent
model: deepseek/deepseek-v4-flash
thinking: off
allowedAgents: scout, debug-subagent
skills: ask-user
systemPrompt: replace
maxDepth: 10
debug: true
---

你是一个 Markdown agent。
```

## Frontmatter alignment

当前 custom-agent 已对齐 `pi-subagents/extensions/agent-loader.ts` 的核心字段：

| field           | default     | note                                               |
| --------------- | ----------- | -------------------------------------------------- |
| `name`          | required    | agent 名称                                         |
| `description`   | optional    | 展示说明                                           |
| `tools`         | `[]`        | CSV，如 `read, subagent`                           |
| `skills`        | `undefined` | CSV，支持 wildcard，如 `obsidian-*`                |
| `model`         | optional    | `provider/model`                                   |
| `thinking`      | `off`       | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `allowedAgents` | `undefined` | 会和实际存在的 agent 名称取交集                    |
| `systemPrompt`  | `append`    | `append`、`replace` 或 `replace-all`               |
| `maxDepth`      | `10`        | 保留字段，方便和 pi-subagents 对齐                 |
| `debug`         | `false`     | 保留字段，方便和 pi-subagents 对齐                 |

刻意差异：

- body 提取使用 `replace(/^\s+/, '')`，避免 append 模式因为 frontmatter 后空行多产生额外空行。

## Skill resolution alignment

已对齐的行为：

- 搜索路径：
  - `<cwd>/.agents/skills/<skill>/SKILL.md`
  - `<cwd>/.pi/skills/<skill>/SKILL.md`
  - `~/.pi/agent/skills/<skill>/SKILL.md`
  - `~/.agents/skills/<skill>/SKILL.md`
  - package-resolved skills
- 支持 wildcard：`skills: obsidian-*`
- 支持 symlink skill dir：扫描 `entry/SKILL.md` 是否可访问，而不是只看 `entry.isDirectory()`
- 返回并打印 warnings：例如 skill frontmatter 缺少 `name`
- skill 注入格式与 pi-subagents 一致：`<available_skills>` XML-like block

## System prompt injection model

custom-agent 的目标是复用 pi-subagents 的 system prompt 结构，同时应用到当前 session。

### replace / replace-all mode

`systemPrompt: replace` 只替换 pi 默认 system prompt，但保留 project context files；`systemPrompt: replace-all` 则同时跳过 project context files。

custom-agent 会在两种 replace 模式下自动插入 Pi 运行时的 `Available tools` 与 `Guidelines` 区块，无需在 agent body 中声明占位符。旧的 `<pi-runtime-tools />` 会在加载时被忽略，以保持兼容。

顺序为：

1. agent prompt
2. `Available tools` / `Guidelines`
3. skills block（如果有）
4. project context（仅 `replace`）
5. `Current working directory`

这对应代码中的：

- `buildAgentPromptWithSkills()`
- `injectRuntimeToolsBlock()`
- `buildPiCustomSystemPrompt()`

### append mode

`systemPrompt: append` 下：

1. 保留 pi 原始 base prompt
2. 去掉 base prompt 里已有的 built-in skills block，避免重复
3. append agent prompt + skills block
4. 由 Pi 0.83 根据 active tool 的 `promptSnippet` 与 `promptGuidelines` 自动组装工具信息

这是 custom-agent 的架构差异：pi-subagents 子进程使用 `--no-skills`，custom-agent 是在当前 session 注入，因此需要 `stripBuiltInSkills()`。

## Available subagents filtering

`allowedAgents` 是执行白名单。custom-agent 在 session start 时通过 `pi.events` 请求 pi-subagents 重新注册受限的 `subagent` 工具：工具实际可执行的 agent、其 `promptGuidelines` 中的代理列表都会使用：

```ts
allowedAgents = existingAgentNames ∩ agent.allowedAgents
```

未声明 `allowedAgents` 时，subagent 工具保持不受限。

## Debugging

启动：

```bash
pi --agent debug-subagent-replace
```

查看最终 system prompt：

```text
/debug-system-prompt
```

注意：`/debug-system-prompt` 走 `promptBridge.getPrompt(ctx.getSystemPrompt(), ctx.getSystemPromptOptions())`。新的 `ctx.getSystemPromptOptions()` 能在命令里拿到 Pi 当前构建 base prompt 的结构化输入，因此 custom-agent 的 bridge 不再依赖上一次 `before_agent_start` 缓存，首次对话前预览也能更接近实际 agent prompt。

## Migration checklist

从 `pi-subagents` 迁移新功能时：

1. 先判断功能属于哪一层：
   - frontmatter parsing → 对照 `agent-loader.ts`
   - skill lookup/injection → 对照 `skill-resolver.ts` 和 `subagent-executor.ts`
   - runtime prompt blocks → 对照 `subagent-prompt.ts`
2. 保持函数语义接近 pi-subagents，但不要引入 spawn/subprocess 逻辑。
3. 更新 `tests/custom-agent.test.ts`：
   - frontmatter 默认值/校验
   - skills wildcard/symlink/warnings
   - replace/append prompt 顺序
   - `/debug-system-prompt` bridge 相关行为（如果涉及 runtime options）
4. 跑检查：

```bash
npx tsc --noEmit --project tsconfig.json
bun test tests/custom-agent.test.ts
```
