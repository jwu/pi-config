import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'minimal' | 'xhigh';
type SystemPromptMode = 'replace' | 'append';
type AgentSource = 'bundled' | 'global' | 'project';

interface AgentConfig {
  name: string;
  description?: string;
  tools: string[];
  model?: string;
  thinking: ThinkingLevel;
  systemPromptMode: SystemPromptMode;
  prompt: string;
  source: AgentSource;
  filePath: string;
}

interface AgentWarning {
  filePath: string;
  message: string;
}

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function bundledAgentsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');
}

function globalAgentsDir(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'agents');
}

function projectAgentsDir(cwd: string): string {
  return path.join(cwd, '.pi', 'agents');
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  if (!content.startsWith('---\n')) throw new Error('missing frontmatter');
  const end = content.indexOf('\n---', 4);
  if (end === -1) throw new Error('missing frontmatter terminator');

  const raw = content.slice(4, end);
  const body = content.slice(end + '\n---'.length).replace(/^\n/, '');
  const data: Record<string, string> = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) throw new Error(`invalid frontmatter line: ${line}`);

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!key) throw new Error(`invalid frontmatter key: ${line}`);

    data[key] = value.replace(/^["']|["']$/g, '');
  }

  return { data, body };
}

function parseAgent(content: string, filePath: string, source: AgentSource): AgentConfig {
  const { data, body } = parseFrontmatter(content);
  if (!data.name) throw new Error('missing required field: name');

  const thinking = (data.thinking ?? 'off') as ThinkingLevel;
  if (!VALID_THINKING_LEVELS.has(thinking)) {
    throw new Error(`invalid thinking: ${data.thinking}`);
  }

  const systemPromptMode = (data.systemPrompt ?? 'replace') as SystemPromptMode;
  if (systemPromptMode !== 'replace' && systemPromptMode !== 'append') {
    throw new Error(`invalid systemPrompt: ${data.systemPrompt}`);
  }

  return {
    name: data.name,
    description: data.description || undefined,
    tools: splitCsv(data.tools),
    model: data.model || undefined,
    thinking,
    systemPromptMode,
    prompt: body,
    source,
    filePath,
  };
}

async function loadAgentsFromDir(
  dir: string,
  source: AgentSource,
  warnings: AgentWarning[],
): Promise<AgentConfig[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => path.join(dir, entry.name))
      .filter((filePath) => filePath.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  const seen = new Set<string>();
  for (const filePath of entries) {
    try {
      const agent = parseAgent(await fs.readFile(filePath, 'utf8'), filePath, source);
      if (seen.has(agent.name)) continue;
      seen.add(agent.name);
      agents.push(agent);
    } catch (error) {
      warnings.push({
        filePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return agents;
}

async function loadAgentDefinitions(cwd: string): Promise<{
  agents: AgentConfig[];
  warnings: AgentWarning[];
}> {
  const warnings: AgentWarning[] = [];
  const byName = new Map<string, AgentConfig>();

  const dirs: Array<[string, AgentSource]> = [
    [bundledAgentsDir(), 'bundled'],
    [globalAgentsDir(), 'global'],
    [projectAgentsDir(cwd), 'project'],
  ];

  for (const [dir, source] of dirs) {
    for (const agent of await loadAgentsFromDir(dir, source, warnings)) {
      byName.set(agent.name, agent);
    }
  }

  return { agents: [...byName.values()], warnings };
}

function modelParts(model: string): { provider: string; id: string } | undefined {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

function agentSummary(agent: AgentConfig): string {
  const parts = [`${agent.name} (${agent.source})`];
  if (agent.model) parts.push(`model:${agent.model}`);
  if (agent.tools.length > 0) parts.push(`tools:${agent.tools.join(',')}`);
  parts.push(`thinking:${agent.thinking}`);
  return parts.join(' ');
}

export default function (pi: ExtensionAPI): void {
  pi.registerFlag('agent', {
    description: 'Run this pi session as a named Markdown agent from agents/*.md',
    type: 'string',
  });

  let activeAgent: AgentConfig | undefined;
  let startupError: string | undefined;

  pi.on('session_start', async (_event, ctx) => {
    activeAgent = undefined;
    startupError = undefined;

    const agentName = pi.getFlag('agent');
    if (typeof agentName !== 'string' || !agentName) return;

    const { agents, warnings } = await loadAgentDefinitions(ctx.cwd);
    for (const warning of warnings) {
      console.warn(`[custom-agent] skipped ${warning.filePath}: ${warning.message}`);
    }

    const agent = agents.find((candidate) => candidate.name === agentName);
    if (!agent) {
      const available = agents
        .map((candidate) => `${candidate.name} (${candidate.source})`)
        .sort()
        .join(', ');
      startupError = `Unknown agent: ${agentName}. Available agents: ${available || 'none'}.`;
      console.error(`[custom-agent] ${startupError}`);
      if (ctx.hasUI) ctx.ui.notify(startupError, 'error');
      return;
    }

    activeAgent = agent;

    if (agent.model) {
      const parts = modelParts(agent.model);
      const model = parts ? ctx.modelRegistry.find(parts.provider, parts.id) : undefined;
      if (!model) {
        const message = `Agent "${agent.name}": model not found: ${agent.model}`;
        console.warn(`[custom-agent] ${message}`);
        if (ctx.hasUI) ctx.ui.notify(message, 'warning');
      } else {
        const ok = await pi.setModel(model);
        if (!ok) {
          const message = `Agent "${agent.name}": no auth configured for ${agent.model}`;
          console.warn(`[custom-agent] ${message}`);
          if (ctx.hasUI) ctx.ui.notify(message, 'warning');
        }
      }
    }

    pi.setThinkingLevel(agent.thinking);

    if (agent.tools.length > 0) {
      const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
      const validTools = agent.tools.filter((tool) => allToolNames.has(tool));
      const invalidTools = agent.tools.filter((tool) => !allToolNames.has(tool));

      if (invalidTools.length > 0) {
        const message = `Agent "${agent.name}": unknown tools: ${invalidTools.join(', ')}`;
        console.warn(`[custom-agent] ${message}`);
        if (ctx.hasUI) ctx.ui.notify(message, 'warning');
      }
      if (validTools.length > 0) pi.setActiveTools(validTools);
    }

    pi.setSessionName(`agent:${agent.name}`);
    if (ctx.hasUI) ctx.ui.notify(`Activated ${agentSummary(agent)}`, 'info');
  });

  pi.on('input', async () => {
    if (!startupError) return { action: 'continue' };
    return { action: 'handled' };
  });

  pi.on('before_agent_start', async (event) => {
    if (!activeAgent) return;

    const prompt = activeAgent.prompt.trimEnd();
    return {
      systemPrompt:
        activeAgent.systemPromptMode === 'append' ? `${event.systemPrompt}\n\n${prompt}` : prompt,
    };
  });
}
