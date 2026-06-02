import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ResolvedResource,
} from '@earendil-works/pi-coding-agent';

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'minimal' | 'xhigh';
type SystemPromptMode = 'replace' | 'append';
type AgentSource = 'global' | 'project';

interface AgentConfig {
  name: string;
  description?: string;
  tools: string[];
  skills: string[];
  model?: string;
  thinking: ThinkingLevel;
  allowedAgents: string[];
  systemPromptMode: SystemPromptMode;
  prompt: string;
  source: AgentSource;
  filePath: string;
}

interface ResolvedSkill {
  name: string;
  description: string;
  location: string;
}

interface DefaultModelSettingsSnapshot {
  exists: boolean;
  hasDefaultProvider: boolean;
  hasDefaultModel: boolean;
  hasDefaultThinkingLevel: boolean;
  defaultProvider?: unknown;
  defaultModel?: unknown;
  defaultThinkingLevel?: unknown;
}

interface AgentWarning {
  filePath: string;
  message: string;
}

interface CustomAgentSystemPromptBridge {
  getPrompt?: (basePrompt: string) => string | undefined;
}

const SYSTEM_PROMPT_BRIDGE = Symbol.for('pi-config.custom-agent.systemPromptBridge');
const systemPromptBridge = globalThis as typeof globalThis & {
  [SYSTEM_PROMPT_BRIDGE]?: CustomAgentSystemPromptBridge;
};

function getSystemPromptBridge(): CustomAgentSystemPromptBridge {
  systemPromptBridge[SYSTEM_PROMPT_BRIDGE] ??= {};
  return systemPromptBridge[SYSTEM_PROMPT_BRIDGE];
}

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function globalAgentsDir(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'agents');
}

function projectAgentsDir(cwd: string): string {
  return path.join(cwd, '.pi', 'agents');
}

function globalSkillsDir(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'skills');
}

function globalSettingsPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'settings.json');
}

function skillFileCandidates(skillName: string, cwd: string): string[] {
  return [
    path.join(cwd, '.agents', 'skills', skillName, 'SKILL.md'),
    path.join(cwd, '.pi', 'skills', skillName, 'SKILL.md'),
    path.join(globalSkillsDir(), skillName, 'SKILL.md'),
    path.join(os.homedir(), '.agents', 'skills', skillName, 'SKILL.md'),
  ];
}

async function resolvePackageSkillFiles(cwd: string): Promise<{
  files: string[];
  skippedPackages: string[];
}> {
  const skippedPackages: string[] = [];
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });
  const resolvedPaths = await packageManager.resolve(async (source) => {
    skippedPackages.push(source);
    return 'skip';
  });

  return {
    files: resolvedPaths.skills
      .filter((resource: ResolvedResource) => resource.enabled)
      .map((resource: ResolvedResource) => resource.path),
    skippedPackages,
  };
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

function parseSkillFrontmatter(
  content: string,
): { name?: string; description?: string } | undefined {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return undefined;
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return undefined;

  const data: Record<string, string> = {};
  const lines = normalized.slice(4, end).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (data._currentBlockKey !== undefined && (line.startsWith('  ') || line.startsWith('\t'))) {
      const current = data[data._currentBlockKey] ?? '';
      data[data._currentBlockKey] = current ? `${current} ${trimmed}` : trimmed;
      continue;
    }
    delete data._currentBlockKey;

    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (value === '|' || value === '>') {
      data._currentBlockKey = key;
      data[key] = '';
      continue;
    }

    value = value.replace(/^["']|["']$/g, '');
    if (key) data[key] = value;
  }
  delete data._currentBlockKey;

  if (!data.description?.trim()) return undefined;
  return { name: data.name, description: data.description.trim() };
}

async function readSkillFromFile(
  filePath: string,
  requestedName: string,
  requireNameMatch: boolean,
): Promise<ResolvedSkill | undefined> {
  const content = await fs.readFile(filePath, 'utf8');
  const frontmatter = parseSkillFrontmatter(content);
  if (!frontmatter) return undefined;

  const fileSkillName = frontmatter.name || path.basename(path.dirname(filePath));
  const markdownName = path.basename(filePath, '.md');
  if (requireNameMatch && fileSkillName !== requestedName && markdownName !== requestedName) {
    return undefined;
  }

  return {
    name: fileSkillName || requestedName,
    description: frontmatter.description || '',
    location: filePath,
  };
}

async function resolveSkills(
  skillNames: string[],
  cwd: string,
): Promise<{ resolved: ResolvedSkill[]; missing: string[]; skippedPackages: string[] }> {
  const resolved: ResolvedSkill[] = [];
  const missing: string[] = [];
  const pendingPackageResolution: string[] = [];

  for (const skillName of skillNames) {
    const trimmed = skillName.trim();
    if (!trimmed) continue;

    let skill: ResolvedSkill | undefined;
    for (const filePath of skillFileCandidates(trimmed, cwd)) {
      try {
        skill = await readSkillFromFile(filePath, trimmed, false);
        if (skill) break;
      } catch {
        // Try the next candidate path.
      }
    }

    if (skill) resolved.push(skill);
    else pendingPackageResolution.push(trimmed);
  }

  const packageSkills =
    pendingPackageResolution.length > 0
      ? await resolvePackageSkillFiles(cwd)
      : { files: [], skippedPackages: [] };

  for (const skillName of pendingPackageResolution) {
    let skill: ResolvedSkill | undefined;
    for (const filePath of packageSkills.files) {
      try {
        skill = await readSkillFromFile(filePath, skillName, true);
        if (skill) break;
      } catch {
        // Try the next package skill file.
      }
    }

    if (skill) resolved.push(skill);
    else missing.push(skillName);
  }

  return { resolved, missing, skippedPackages: packageSkills.skippedPackages };
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
    skills: splitCsv(data.skills),
    model: data.model || undefined,
    thinking,
    allowedAgents: splitCsv(data.allowedAgents),
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

function agentSummary(agent: AgentConfig): string {
  const sourceLabel: Record<AgentSource, string> = {
    global: 'g',
    project: 'p',
  };
  return `${agent.name} [${sourceLabel[agent.source]}] activated`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatAvailableSubagentsBlock(agentNames: string[]): string | undefined {
  const names = [...new Set(agentNames.map((name) => name.trim()).filter(Boolean))].sort();
  if (names.length === 0) return undefined;

  return ['Available subagents:', ...names.map((name) => `- ${name}`)].join('\n');
}

function formatSkillsForPrompt(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return '';

  const lines = [
    '',
    '',
    'The following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];

  for (const skill of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.location)}</location>`);
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');
  return lines.join('\n');
}

function stripBuiltInSkills(prompt: string): string {
  return prompt
    .replace(
      /\n*The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/g,
      '',
    )
    .trimEnd();
}

function agentPromptWithInjections(
  agent: AgentConfig,
  skills: ResolvedSkill[],
  availableSubagents: string[],
  basePrompt: string,
): string {
  let prompt = agent.prompt.trimEnd();

  if (agent.tools.includes('subagent') || agent.allowedAgents.length > 0) {
    const availableSubagentsBlock = formatAvailableSubagentsBlock(availableSubagents);
    const alreadyInPrompt = availableSubagentsBlock && prompt.includes(availableSubagentsBlock);
    const alreadyInBase =
      agent.systemPromptMode === 'append' &&
      availableSubagentsBlock &&
      basePrompt.includes(availableSubagentsBlock);
    if (availableSubagentsBlock && !alreadyInPrompt && !alreadyInBase) {
      prompt = `${prompt}\n\n${availableSubagentsBlock}`;
    }
  }

  return `${prompt}${formatSkillsForPrompt(skills)}`.trimEnd();
}

function buildAgentSystemPrompt(
  agent: AgentConfig,
  basePrompt: string,
  skills: ResolvedSkill[],
  availableSubagents: string[],
): string {
  const prompt = agentPromptWithInjections(agent, skills, availableSubagents, basePrompt);
  if (agent.systemPromptMode === 'replace') return prompt;

  const trimmedBase = stripBuiltInSkills(basePrompt);
  if (!prompt) return trimmedBase;
  if (trimmedBase.endsWith(prompt)) return basePrompt;
  return `${trimmedBase}\n\n${prompt}`;
}

export const __testing = {
  buildAgentSystemPrompt,
  formatAvailableSubagentsBlock,
  parseAgent,
  resolveSkills,
};

export default function (pi: ExtensionAPI): void {
  pi.registerFlag('agent', {
    description: 'Run this pi session as a named Markdown agent from agents/*.md',
    type: 'string',
  });

  let activeAgent: AgentConfig | undefined;
  let activeSkills: ResolvedSkill[] = [];
  let activeAvailableSubagents: string[] = [];
  let startupError: string | undefined;
  const promptBridge = getSystemPromptBridge();

  pi.on('session_start', async (_event, ctx) => {
    activeAgent = undefined;
    activeSkills = [];
    activeAvailableSubagents = [];
    startupError = undefined;
    promptBridge.getPrompt = undefined;

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
    activeAvailableSubagents =
      agent.allowedAgents.length > 0
        ? agent.allowedAgents
        : agents.map((candidate) => candidate.name);
    if (agent.skills.length > 0) {
      const { resolved, missing, skippedPackages } = await resolveSkills(agent.skills, ctx.cwd);
      activeSkills = resolved;
      for (const source of skippedPackages) {
        console.warn(`[custom-agent] skipped package during skill resolution: ${source}`);
      }
      for (const skillName of missing) {
        const message = `Agent "${agent.name}": skill not found: ${skillName}`;
        console.warn(`[custom-agent] ${message}`);
        if (ctx.hasUI) ctx.ui.notify(message, 'warning');
      }
    }
    promptBridge.getPrompt = (basePrompt) =>
      buildAgentSystemPrompt(agent, basePrompt, activeSkills, activeAvailableSubagents);

    if (agent.model) {
      const parts = modelParts(agent.model);
      const model = parts ? ctx.modelRegistry.find(parts.provider, parts.id) : undefined;
      if (!model) {
        const message = `Agent "${agent.name}": model not found: ${agent.model}`;
        console.warn(`[custom-agent] ${message}`);
        if (ctx.hasUI) ctx.ui.notify(message, 'warning');
      } else {
        const ok = await setModelWithoutSavingDefault(pi, model);
        if (!ok) {
          const message = `Agent "${agent.name}": no auth configured for ${agent.model}`;
          console.warn(`[custom-agent] ${message}`);
          if (ctx.hasUI) ctx.ui.notify(message, 'warning');
        }
      }
    }

    await setThinkingLevelWithoutSavingDefault(pi, agent.thinking);

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
    if (ctx.hasUI) ctx.ui.notify(agentSummary(agent), 'info');
  });

  pi.on('input', async () => {
    if (!startupError) return { action: 'continue' };
    return { action: 'handled' };
  });

  pi.on('before_agent_start', async (event) => {
    if (!activeAgent) return;

    return {
      systemPrompt: buildAgentSystemPrompt(
        activeAgent,
        event.systemPrompt,
        activeSkills,
        activeAvailableSubagents,
      ),
    };
  });
}
