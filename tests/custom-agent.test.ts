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

  test('injects allowedAgents even when the agent does not expose the subagent tool', () => {
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
    expect(buildAgentSystemPrompt(agent, 'base prompt', [], agent.allowedAgents)).toContain(
      'Available subagents:\n- scout',
    );
  });

  test('injects all available agents when the active agent exposes the subagent tool', () => {
    const agent = parseAgent(
      `---
name: delegator
tools: read, subagent
thinking: off
---

Delegate when useful.
`,
      '/repo/agents/delegator.md',
      'global',
    );

    expect(buildAgentSystemPrompt(agent, 'base prompt', [], ['worker', 'scout']).trimStart()).toBe(
      'Delegate when useful.\n\nAvailable subagents:\n- scout\n- worker',
    );
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
    );

    expect(prompt.match(/Available subagents:/g)?.length).toBe(1);
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
});
