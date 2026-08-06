import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { __testing } from '../extensions/custom-agent.ts';

const {
  agentSummary,
  allowedSubagentsForAgent,
  buildAgentSystemPrompt,
  isAgentPathSelector,
  loadAgentFromPath,
  parseAgent,
  resolveAgentFilePath,
  resolveSkills,
} = __testing;

describe('custom-agent prompt injections', () => {
  test('filters an agent allowlist against registered agents', () => {
    const agent = parseAgent(
      `---
name: test-subagent
tools: read
thinking: off
allowedAgents: scout, missing
---

你是用来测试 subagent 的各方面的
`,
      '/repo/agents/test-subagent.md',
      'global',
    );

    expect(allowedSubagentsForAgent(agent, ['worker', 'scout'])).toEqual(['scout']);
  });

  test('leaves the subagent tool unscoped when allowedAgents is omitted', () => {
    const agent = parseAgent(
      `---
name: delegator
tools: subagent
thinking: off
---

Delegate when useful.
`,
      '/repo/agents/delegator.md',
      'global',
    );

    expect(allowedSubagentsForAgent(agent, ['worker', 'scout'])).toBeUndefined();
  });

  test('automatically injects available tools and guidelines in replace mode', () => {
    const agent = parseAgent(
      `---
name: replacer
tools: read, bash
thinking: off
systemPrompt: replace
---

Replace instructions.
`,
      '/repo/agents/replacer.md',
      'global',
    );

    const prompt = buildAgentSystemPrompt(agent, 'base prompt', [], {
      selectedTools: ['read', 'bash', 'subagent'],
      toolSnippets: {
        read: 'Read the contents of a file.',
        bash: 'Execute a bash command.',
      },
      promptGuidelines: ['Prefer read over cat'],
    });

    expect(prompt).toContain(
      'Available tools:\n- read: Read the contents of a file.\n- bash: Execute a bash command.',
    );
    expect(prompt).toContain(
      'Guidelines:\n- Use bash for file operations like ls, rg, find\n- Prefer read over cat',
    );
    expect(prompt).not.toContain('<pi-runtime-tools />');
    expect(prompt.indexOf('Available tools:')).toBeLessThan(prompt.indexOf('Guidelines:'));
  });

  test('places automatic runtime tools between the agent body and skills', () => {
    const agent = parseAgent(
      `---
name: replacer
tools: read
thinking: off
systemPrompt: replace
---

Replace instructions.
`,
      '/repo/agents/replacer.md',
      'global',
    );
    const prompt = buildAgentSystemPrompt(
      agent,
      'base prompt',
      [
        {
          name: 'example-skill',
          description: 'Example skill.',
          location: '/skills/example-skill/SKILL.md',
        },
      ],
      {
        selectedTools: ['read'],
        toolSnippets: { read: 'Read the contents of a file.' },
      },
    );

    expect(prompt.indexOf('Replace instructions.')).toBeLessThan(prompt.indexOf('Available tools:'));
    expect(prompt.indexOf('Available tools:')).toBeLessThan(prompt.indexOf('<available_skills>'));
    expect(prompt).not.toContain('<pi-subagents-runtime-tools />');
  });

  test('strips legacy runtime tools placeholders while loading an agent', () => {
    const agent = parseAgent(
      `---
name: legacy-replacer
tools: read
thinking: off
systemPrompt: replace
---

Replace instructions.

<pi-runtime-tools />
`,
      '/repo/agents/legacy-replacer.md',
      'global',
    );

    expect(agent.prompt).not.toContain('<pi-runtime-tools />');
  });

  test('keeps project context in replace mode but skips it in replace-all mode', () => {
    const replaceAgent = parseAgent(
      `---
name: replacer
tools: read
thinking: off
systemPrompt: replace
---

Replace instructions.
`,
      '/repo/agents/replacer.md',
      'global',
    );
    const replaceAllAgent = parseAgent(
      `---
name: isolated
tools: read
thinking: off
systemPrompt: replace-all
---

Isolated instructions.
`,
      '/repo/agents/isolated.md',
      'global',
    );

    const options = {
      cwd: '/repo',
      contextFiles: [{ path: 'AGENTS.md', content: 'Project rules.' }],
      selectedTools: ['read'],
      toolSnippets: { read: 'Read the contents of a file.' },
    };

    const replacePrompt = buildAgentSystemPrompt(replaceAgent, 'base prompt', [], options);
    const replaceAllPrompt = buildAgentSystemPrompt(replaceAllAgent, 'base prompt', [], options);

    expect(replacePrompt).toContain('<project_instructions path="AGENTS.md">\nProject rules.');
    expect(replacePrompt).toContain('Available tools:\n- read: Read the contents of a file.');
    expect(replacePrompt.indexOf('Available tools:')).toBeLessThan(
      replacePrompt.indexOf('</project_context>'),
    );
    expect(replacePrompt).not.toContain('Current date:');
    expect(replacePrompt).toContain('Current working directory: /repo');

    expect(replaceAllPrompt).not.toContain('<project_context>');
    expect(replaceAllPrompt).toContain('Current working directory: /repo');
  });
});

describe('custom-agent agent selection', () => {
  test('recognizes Markdown file paths as agent selectors', () => {
    expect(isAgentPathSelector('agents/reviewer.md')).toBe(true);
    expect(isAgentPathSelector('reviewer.md')).toBe(true);
    expect(isAgentPathSelector('reviewer')).toBe(false);
  });

  test('loads an agent from a relative Markdown path', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-agent-path-'));
    const filePath = path.join(cwd, 'agents', 'path-agent.md');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `---
name: path-agent
tools: read
thinking: off
---

Loaded from a direct path.
`,
      'utf8',
    );

    try {
      const agent = await loadAgentFromPath('agents/path-agent.md', cwd);
      expect(agent).toMatchObject({
        name: 'path-agent',
        source: 'path',
        filePath,
        tools: ['read'],
      });
      expect(agent.prompt).toBe('Loaded from a direct path.\n');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test('resolves direct agent paths relative to cwd', () => {
    const cwd = path.join(os.tmpdir(), 'custom-agent-cwd');
    expect(resolveAgentFilePath('agents/path-agent.md', cwd)).toBe(
      path.join(cwd, 'agents', 'path-agent.md'),
    );
  });

  test('summarizes path-loaded agents with the relative Markdown path', () => {
    const cwd = path.join(os.tmpdir(), 'custom-agent-cwd');
    const agent = parseAgent(
      `---
name: scout
thinking: off
---

Scout instructions.
`,
      path.join(cwd, 'path', 'to', 'agent.md'),
      'path',
    );

    expect(agentSummary(agent, cwd)).toBe(
      `scout [${path.join('path', 'to', 'agent.md')}] activated`,
    );
  });

  test('summarizes project agents with local source label', () => {
    const cwd = path.join(os.tmpdir(), 'custom-agent-cwd');
    const agent = parseAgent(
      `---
name: local-agent
thinking: off
---

Local instructions.
`,
      path.join(cwd, '.pi', 'agents', 'local-agent.md'),
      'project',
    );

    expect(agentSummary(agent, cwd)).toBe('local-agent [l] activated');
  });
});

describe('custom-agent skill resolution', () => {
  test('resolves project .pi skills by frontmatter', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-agent-skills-'));
    await fs.mkdir(path.join(cwd, '.pi', 'skills', 'ask-user'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.pi', 'skills', 'ask-user', 'SKILL.md'),
      `---
name: ask-user
description: Use ask_user for ambiguous decisions.
---

# Ask User
`,
      'utf8',
    );

    try {
      const result = await resolveSkills(['ask-user'], cwd);
      expect(result.missing).toEqual([]);
      expect(result.resolved).toEqual([
        {
          name: 'ask-user',
          description: 'Use ask_user for ambiguous decisions.',
          location: path.join(cwd, '.pi', 'skills', 'ask-user', 'SKILL.md'),
        },
      ]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test('resolves symlinked skill directories', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-agent-symlink-skills-'));
    const realDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-agent-real-skill-'));
    await fs.mkdir(path.join(cwd, '.pi', 'skills'), { recursive: true });
    await fs.writeFile(
      path.join(realDir, 'SKILL.md'),
      `---
name: linked-skill
description: Skill from symlinked directory.
---

# Linked Skill
`,
      'utf8',
    );
    await fs.symlink(realDir, path.join(cwd, '.pi', 'skills', 'linked-skill'), 'dir');

    try {
      const result = await resolveSkills(['linked-skill'], cwd);
      expect(result.missing).toEqual([]);
      expect(result.resolved[0]?.name).toBe('linked-skill');
      expect(result.resolved[0]?.location).toBe(
        path.join(cwd, '.pi', 'skills', 'linked-skill', 'SKILL.md'),
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(realDir, { recursive: true, force: true });
    }
  });

  test('reports warnings for invalid skill frontmatter', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-agent-skill-warnings-'));
    await fs.mkdir(path.join(cwd, '.pi', 'skills', 'missing-name'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.pi', 'skills', 'missing-name', 'SKILL.md'),
      `---
description: Missing required name.
---

# Missing Name
`,
      'utf8',
    );

    try {
      const result = await resolveSkills(['missing-name'], cwd);
      expect(result.missing).toEqual(['missing-name']);
      expect(result.warnings[0]).toContain('skill missing required field: name:');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
