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
  delegationScopeEvent,
  herdrAgentTools,
  herdrDelegationTools,
  loadAgentDefinitions,
  loadAgentFromPath,
  narrowAllowedAgents,
  selectAgentModel,
  selectAgentTools,
  type AgentProfile as AgentConfig,
  type AgentSource,
  type DelegationScope,
} from '@johnnywu/pi-agent-profiles';

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

function allowedSubagentsForAgent(
  agent: AgentConfig,
  allAgentNames: string[],
): string[] | undefined {
  if (!agent.allowedAgents?.length) return undefined;
  return narrowAllowedAgents(allAgentNames, agent.allowedAgents)?.sort();
}

// In a Herdr lead, `subagent` also selects the pi-herdr-agents delegation tools, as it does for
// Herdr children.
function agentToolEntries(agent: AgentConfig, available: readonly string[]): string[] {
  if (!available.includes('hc_subagent')) return agent.tools;
  return herdrAgentTools(agent.tools, { keepSubagent: true });
}

// `maxDepth: 0` forbids delegation, so the lead loses the blocking tool and the Herdr ones.
function withoutDelegationTools(tools: readonly string[]): string[] {
  const delegation: readonly string[] = ['subagent', ...herdrDelegationTools];
  return tools.filter((name) => !delegation.includes(name));
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
  agentToolEntries,
  allowedSubagentsForAgent,
  isAgentPathSelector,
  withoutDelegationTools,
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
    pi.events.emit(delegationScopeEvent, {} satisfies DelegationScope);
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
    pi.events.emit(delegationScopeEvent, {
      allowedAgents: allowedSubagentsForAgent(
        agent,
        availableAgents.map((candidate) => candidate.name),
      ),
      maxDepth: agent.maxDepth,
    } satisfies DelegationScope);
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
        if (!(await pi.setModel(model))) {
          throw new Error(`no auth configured for ${selected}`);
        }
      }
    } catch (error) {
      const message = `Agent "${agent.name}": ${error instanceof Error ? error.message : String(error)}`;
      console.warn(`[custom-agent] ${message}`);
      if (ctx.hasUI) ctx.ui.notify(message, 'warning');
    }

    pi.setThinkingLevel(agent.thinking);

    let activeTools: string[] | undefined;
    if (agent.tools.length > 0) {
      const available = pi.getAllTools().map((tool) => tool.name);
      const { selected, missing } = selectAgentTools(
        agentToolEntries(agent, available),
        available,
        pi.getActiveTools(),
      );
      if (missing.length > 0) {
        const message = `Agent "${agent.name}": tools did not match: ${missing.join(', ')}`;
        console.warn(`[custom-agent] ${message}`);
        if (ctx.hasUI) ctx.ui.notify(message, 'warning');
      }
      activeTools = selected;
    }
    if (agent.maxDepth === 0) {
      activeTools = withoutDelegationTools(activeTools ?? pi.getActiveTools());
    }
    if (activeTools) pi.setActiveTools(activeTools);

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
