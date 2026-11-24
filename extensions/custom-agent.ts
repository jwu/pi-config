import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type NormalizedBuildSystemPromptOptions,
} from '@earendil-works/pi-coding-agent';
import {
  applyAgentProfile,
  loadAgentDefinitions,
  loadAgentFromPath,
  selectAgentModel,
  selectAgentTools,
  type AgentProfile as AgentConfig,
  type AgentSource,
  type ThinkingLevel,
} from '@johnnywu/pi-agent-profiles';

interface DefaultModelSettingsSnapshot {
  exists: boolean;
  hasDefaultProvider: boolean;
  hasDefaultModel: boolean;
  hasDefaultThinkingLevel: boolean;
  defaultProvider?: unknown;
  defaultModel?: unknown;
  defaultThinkingLevel?: unknown;
}

interface CustomAgentSystemPromptBridge {
  getPrompt?: (basePrompt: string, options?: BuildSystemPromptOptions) => string | undefined;
}

const SYSTEM_PROMPT_BRIDGE = Symbol.for('pi-config.custom-agent.systemPromptBridge');
const systemPromptBridge = globalThis as typeof globalThis & {
  [SYSTEM_PROMPT_BRIDGE]?: CustomAgentSystemPromptBridge;
};

function getSystemPromptBridge(): CustomAgentSystemPromptBridge {
  systemPromptBridge[SYSTEM_PROMPT_BRIDGE] ??= {};
  return systemPromptBridge[SYSTEM_PROMPT_BRIDGE];
}

function isAgentPathSelector(selector: string): boolean {
  const trimmed = selector.trim();
  return trimmed.toLowerCase().endsWith('.md') || /[/\\]/.test(trimmed);
}

function globalSettingsPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'settings.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readGlobalSettings(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(globalSettingsPath(), 'utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function snapshotDefaultModelSettings(): Promise<DefaultModelSettingsSnapshot> {
  let exists = true;
  try {
    await fs.access(globalSettingsPath());
  } catch {
    exists = false;
  }

  const settings = await readGlobalSettings();
  return {
    exists,
    hasDefaultProvider: Object.hasOwn(settings, 'defaultProvider'),
    hasDefaultModel: Object.hasOwn(settings, 'defaultModel'),
    hasDefaultThinkingLevel: Object.hasOwn(settings, 'defaultThinkingLevel'),
    defaultProvider: settings.defaultProvider,
    defaultModel: settings.defaultModel,
    defaultThinkingLevel: settings.defaultThinkingLevel,
  };
}

async function restoreDefaultModelSettings(snapshot: DefaultModelSettingsSnapshot): Promise<void> {
  const settings = await readGlobalSettings();

  if (snapshot.hasDefaultProvider) settings.defaultProvider = snapshot.defaultProvider;
  else delete settings.defaultProvider;

  if (snapshot.hasDefaultModel) settings.defaultModel = snapshot.defaultModel;
  else delete settings.defaultModel;

  if (snapshot.hasDefaultThinkingLevel) {
    settings.defaultThinkingLevel = snapshot.defaultThinkingLevel;
  } else {
    delete settings.defaultThinkingLevel;
  }

  if (!snapshot.exists && Object.keys(settings).length === 0) {
    try {
      await fs.unlink(globalSettingsPath());
    } catch {
      // Ignore cleanup errors.
    }
    return;
  }

  await fs.mkdir(path.dirname(globalSettingsPath()), { recursive: true });
  await fs.writeFile(globalSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

async function setModelWithoutSavingDefault(
  pi: ExtensionAPI,
  model: Parameters<ExtensionAPI['setModel']>[0],
): Promise<boolean> {
  const snapshot = await snapshotDefaultModelSettings();
  try {
    return await pi.setModel(model);
  } finally {
    await restoreDefaultModelSettings(snapshot);
  }
}

async function setThinkingLevelWithoutSavingDefault(
  pi: ExtensionAPI,
  level: ThinkingLevel,
): Promise<void> {
  const snapshot = await snapshotDefaultModelSettings();
  try {
    pi.setThinkingLevel(level);
  } finally {
    await restoreDefaultModelSettings(snapshot);
  }
}

function allowedSubagentsForAgent(
  agent: AgentConfig,
  allAgentNames: string[],
): string[] | undefined {
  if ((agent.allowedAgents?.length ?? 0) === 0) return undefined;

  const allowed = new Set(agent.allowedAgents);
  return [...new Set(allAgentNames.filter((name) => allowed.has(name)))].sort();
}

function displayAgentPath(filePath: string, cwd: string): string {
  const relative = path.relative(cwd, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;

  const home = os.homedir();
  const homeRelative = path.relative(home, filePath);
  if (homeRelative && !homeRelative.startsWith('..') && !path.isAbsolute(homeRelative)) {
    return path.join('~', homeRelative);
  }

  return filePath;
}

function agentSummary(agent: AgentConfig, cwd: string): string {
  const sourceLabel: Record<Exclude<AgentSource, 'path'>, string> = {
    global: 'g',
    project: 'l',
  };
  const label =
    agent.source === 'path' ? displayAgentPath(agent.filePath, cwd) : sourceLabel[agent.source];
  return `${agent.name} [${label}] activated`;
}

function previewAgentPrompt(
  agent: AgentConfig,
  base: string,
  input: BuildSystemPromptOptions,
): string {
  const options: NormalizedBuildSystemPromptOptions = {
    ...input,
    selectedTools: input.selectedTools ?? [],
    hiddenTools: input.hiddenTools ?? [],
    toolSnippets: input.toolSnippets ?? {},
    toolGuidelines: input.toolGuidelines ?? {},
    promptGuidelines: input.promptGuidelines ?? [],
    appendSystemPrompt: input.appendSystemPrompt ?? '',
    sections: input.sections ?? {},
    contextFiles: input.contextFiles ?? [],
    skills: input.skills ?? [],
  };
  applyAgentProfile(agent, options);

  // The preview command can run before Pi has rendered the first agent turn.
  const section = (name: string) => base.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`))?.[0];
  const preamble = base
    .split(/\n<(?:tools|rules|docs|addendum|project_context|skills|cwd)>/)[0]
    .trimEnd();
  const reader = options.selectedTools.find((name) => name === 'read' || name === 'bash');
  const skills = formatSkillsForPrompt(
    options.skills,
    reader === 'read' || reader === 'bash' ? reader : 'indirect',
  ).trim();
  return [
    options.customPrompt ?? preamble,
    ...(options.customPrompt ? [] : ['tools', 'rules', 'docs'].map(section)),
    options.appendSystemPrompt && `<addendum>\n${options.appendSystemPrompt}\n</addendum>`,
    options.contextFiles.length && section('project_context'),
    skills && `<skills>\n${skills}\n</skills>`,
    section('cwd'),
    ...Object.keys(options.sections).map(section),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const __testing = {
  agentSummary,
  allowedSubagentsForAgent,
  isAgentPathSelector,
  previewAgentPrompt,
};

export default function (pi: ExtensionAPI): void {
  pi.registerFlag('agent', {
    description:
      'Run this pi session as a named Markdown agent from agents/*.md, or from a .md path',
    type: 'string',
  });

  let activeAgent: AgentConfig | undefined;
  let startupError: string | undefined;
  const warnedSkills = new Set<string>();
  const promptBridge = getSystemPromptBridge();

  pi.on('session_start', async (_event, ctx) => {
    activeAgent = undefined;
    warnedSkills.clear();
    pi.events.emit('pi-subagents:configure', { allowedAgents: undefined });
    startupError = undefined;
    promptBridge.getPrompt = undefined;

    const agentSelector = pi.getFlag('agent');
    if (typeof agentSelector !== 'string' || !agentSelector) return;

    const { agents, warnings } = await loadAgentDefinitions({ cwd: ctx.cwd });
    for (const warning of warnings) {
      console.warn(`[custom-agent] skipped ${warning.filePath}: ${warning.message}`);
    }

    let agent: AgentConfig | undefined;
    let availableAgents = agents;
    if (isAgentPathSelector(agentSelector)) {
      try {
        agent = await loadAgentFromPath(agentSelector, ctx.cwd);
        const byName = new Map(agents.map((candidate) => [candidate.name, candidate]));
        byName.set(agent.name, agent);
        availableAgents = [...byName.values()];
      } catch (error) {
        startupError = `Agent file could not be loaded: ${agentSelector}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[custom-agent] ${startupError}`);
        if (ctx.hasUI) ctx.ui.notify(startupError, 'error');
        return;
      }
    } else {
      agent = agents.find((candidate) => candidate.name === agentSelector);
    }

    if (!agent) {
      const available = agents
        .map((candidate) => `${candidate.name} (${candidate.source})`)
        .sort()
        .join(', ');
      startupError = `Unknown agent: ${agentSelector}. Available agents: ${available || 'none'}.`;
      console.error(`[custom-agent] ${startupError}`);
      if (ctx.hasUI) ctx.ui.notify(startupError, 'error');
      return;
    }

    activeAgent = agent;
    pi.events.emit('pi-subagents:configure', {
      allowedAgents: allowedSubagentsForAgent(
        agent,
        availableAgents.map((candidate) => candidate.name),
      ),
    });
    promptBridge.getPrompt = (base, options) =>
      options ? previewAgentPrompt(agent, base, options) : base;

    try {
      const selected = selectAgentModel(agent, undefined, () => ctx.modelRegistry.getAvailable());
      if (selected) {
        const models = ctx.modelRegistry.getAll();
        const model =
          models.find(({ provider, id }) => `${provider}/${id}` === selected) ??
          ctx.modelRegistry.getAvailable().find(({ id }) => id === selected) ??
          models.find(({ id }) => id === selected);
        if (!model) throw new Error(`model not found: ${selected}`);
        if (!(await setModelWithoutSavingDefault(pi, model))) {
          throw new Error(`no auth configured for ${selected}`);
        }
      }
    } catch (error) {
      const message = `Agent "${agent.name}": ${error instanceof Error ? error.message : String(error)}`;
      console.warn(`[custom-agent] ${message}`);
      if (ctx.hasUI) ctx.ui.notify(message, 'warning');
    }

    await setThinkingLevelWithoutSavingDefault(pi, agent.thinking);

    if (agent.tools.length > 0) {
      const { selected, missing } = selectAgentTools(
        agent.tools,
        pi.getAllTools().map((tool) => tool.name),
        pi.getActiveTools(),
      );
      if (missing.length > 0) {
        const message = `Agent "${agent.name}": tools did not match: ${missing.join(', ')}`;
        console.warn(`[custom-agent] ${message}`);
        if (ctx.hasUI) ctx.ui.notify(message, 'warning');
      }
      pi.setActiveTools(selected);
    }

    pi.setSessionName(`agent:${agent.name}`);
    if (ctx.hasUI) ctx.ui.notify(agentSummary(agent, ctx.cwd), 'info');
  });

  pi.on('input', async () => {
    if (!startupError) return { action: 'continue' };
    return { action: 'handled' };
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (startupError) {
      ctx.abort();
      return;
    }
    if (!activeAgent) return;
    const { missingSkills } = applyAgentProfile(activeAgent, event.systemPromptOptions);
    for (const name of missingSkills) {
      if (warnedSkills.has(name)) continue;
      warnedSkills.add(name);
      const message = `Agent "${activeAgent.name}": skill not found: ${name}`;
      console.warn(`[custom-agent] ${message}`);
      if (ctx.hasUI) ctx.ui.notify(message, 'warning');
    }
    if (activeAgent.debug) {
      await fs.writeFile(path.join(ctx.cwd, 'debug-system-prompt.md'), event.systemPrompt, {
        mode: 0o600,
      });
    }
  });
}
