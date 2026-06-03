import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { __testing } from '../extensions/custom-agent.ts';

const { buildAgentSystemPrompt, formatAvailableSubagentsBlock, parseAgent, resolveSkills } =
  __testing;

describe('custom-agent prompt injections', () => {
  test('formats available subagents as a sorted standalone block', () => {
    expect(formatAvailableSubagentsBlock(['worker', 'scout', 'scout'])).toBe(
      'Available subagents:\n- scout\n- worker',
    );
  });

  test('does not inject allowedAgents when subagent tool is not selected', () => {
    const agent = parseAgent(
      `---
name: test-subagent
description: 测试 subagent
tools: read
model: deepseek/deepseek-v4-flash
thinking: off
allowedAgents: scout
skills: ask-user
---

你是用来测试 subagent 的各方面的
`,
      '/repo/agents/test-subagent.md',
      'global',
    );

    expect(agent.allowedAgents).toEqual(['scout']);
    expect(
      buildAgentSystemPrompt(agent, 'base prompt', [], agent.allowedAgents!, {
        selectedTools: ['read'],
      }),
    ).not.toContain('Available subagents:');
  });

  test('injects all available agents when the subagent tool is selected', () => {
    const agent = parseAgent(
      `---
name: delegator
tools: read, subagent
thinking: off
systemPrompt: replace
---

Delegate when useful.
`,
      '/repo/agents/delegator.md',
      'global',
    );

    expect(
      buildAgentSystemPrompt(agent, 'base prompt', [], ['worker', 'scout'], {
        selectedTools: ['read', 'subagent'],
      }).trimStart(),
    ).toBe('Delegate when useful.\n\nAvailable subagents:\n- scout\n- worker');
  });

  test('does not duplicate an available subagents block in append mode', () => {
    const agent = parseAgent(
      `---
name: delegator
tools: subagent
thinking: off
systemPrompt: append
---

Extra instructions.
`,
      '/repo/agents/delegator.md',
      'global',
    );

    const prompt = buildAgentSystemPrompt(
      agent,
      'Base prompt.\n\nAvailable subagents:\n- scout',
      [],
      ['scout'],
      { selectedTools: ['subagent'] },
    );

    expect(prompt.match(/Available subagents:/g)?.length).toBe(1);
  });

  test('injects available tools and guidelines in replace mode', () => {
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

    const prompt = buildAgentSystemPrompt(agent, 'base prompt', [], ['scout'], {
      selectedTools: ['read', 'bash', 'subagent'],
      toolSnippets: {
        read: 'Read the contents of a file.',
        bash: 'Execute a bash command.',
      },
      promptGuidelines: ['Prefer read over cat'],
      injectToolGuidelines: true,
    });

    expect(prompt).toContain('Available tools:\n- read: Read the contents of a file.\n- bash: Execute a bash command.');
    expect(prompt).toContain('Guidelines:\n- Use bash for file operations like ls, rg, find\n- Prefer read over cat');
    expect(prompt).toContain('Available subagents:\n- scout');
    expect(prompt.indexOf('Available tools:')).toBeLessThan(prompt.indexOf('Guidelines:'));
    expect(prompt.indexOf('Guidelines:')).toBeLessThan(prompt.indexOf('Available subagents:'));
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
