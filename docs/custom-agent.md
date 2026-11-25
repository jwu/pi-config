# custom-agent

`extensions/custom-agent.ts` 将 Markdown agent 应用到当前 `pi --agent <name>` 会话。`@johnnywu/pi-agent-profiles` 与 pi-subagents、pi-herdr-agents 共用解析、技能匹配和提示词组装规则。

在 pi-config 运行 `bun install`，从 npm 安装共享包。

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
models: deepseek/deepseek-v4-flash, magpie/claude/*
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

共享包解析以下字段。

| field           | default     | note                                               |
| --------------- | ----------- | -------------------------------------------------- |
| `name`          | required    | agent 名称                                         |
| `description`   | optional    | 展示说明                                           |
| `tools`         | `[]`        | CSV，支持 `*` 通配符或 `+` / `-` 增减工具          |
| `skills`        | `undefined` | CSV，支持 wildcard，如 `obsidian-*`                |
| `models`        | optional    | CSV 模型 ID 或 `*` 通配符，当前会话默认使用首项     |
| `thinking`      | `off`       | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `allowedAgents` | `undefined` | 会和实际存在的 agent 名称取交集                    |
| `systemPrompt`  | `append`    | `append`、`replace` 或 `replace-all`               |
| `maxDepth`      | `10`        | 保留字段，方便和 pi-subagents 对齐                 |
| `debug`         | `false`     | 在工作目录写入 `debug-system-prompt.md`            |

首项为通配符时，选择 Pi 当前可用模型中的第一个匹配项。模型找不到或缺少认证时，`custom-agent` 会发出警告并保留当前会话模型。请将旧的 `model:` 字段重命名为 `models:`，否则加载器会警告并跳过该定义。

`tools: read, hc_*` 将当前会话的活跃工具设为匹配项。`tools: +grep, -write` 在当前活跃工具上增减精确名称。两种写法应分别使用，省略或留空时沿用当前工具。在 Herdr 中加载了 pi-herdr-agents（已注册 `hc_subagent`）时，`subagent` 还会选中 `hc_subagent`、`hc_renew`、`hc_read`、`hc_stop`、`hc_rm`，非空列表另加 `hc_send` 和 `hc_agents`，规则来自 `herdrAgentTools()`。找不到的名称或模式会发出警告。白名单没有任何匹配时，会清空活跃工具。

## Skills 和系统提示词

Pi 发现当前会话可用的技能，共享包按 `skills` 中的名称或 `*` 通配符筛选并提示缺失项。Pi 负责呈现技能说明。

- `append` 保留 Pi 的默认系统提示词和现有附加提示，再追加 Agent 正文。
- `replace` 使用 Agent 正文和运行时工具说明作为自定义提示词，并保留项目上下文。
- `replace-all` 同时跳过项目上下文。

两种替换模式都会根据实际启用的工具注入说明。可用 `<pi-subagents-runtime-tools />` 指定放置位置。

## Available subagents filtering

`allowedAgents` 是执行白名单。custom-agent 在 session start 时通过 `pi.events` 请求 pi-subagents 重新注册受限的 `subagent` 工具：工具实际可执行的 agent、其 `promptGuidelines` 中的代理列表都会使用：

```ts
allowedAgents = existingAgentNames ∩ agent.allowedAgents
```

pi-herdr-agents 也监听同一个 `pi-subagents:configure` 事件，用同一份名单限制 `hc_subagent`。

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

## 测试

`bun run lint` 会检查格式和类型，并运行整个 pi-config 测试套件。共享规则的测试位于 pi-agent-profiles，当前会话入口和预览测试位于 `tests/custom-agent.test.ts`。
