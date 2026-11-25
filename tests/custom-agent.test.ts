import { parseAgentProfile as parseAgent, loadAgentFromPath } from '@johnnywu/pi-agent-profiles';
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { __testing } from '../extensions/custom-agent.ts';

const {
  agentSummary,
  agentToolEntries,
  allowedSubagentsForAgent,
  isAgentPathSelector,
  previewAgentPrompt,
  withoutDelegationTools,
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

  test('adds the Herdr delegation tools to subagent only when pi-herdr-agents is loaded', () => {
    const agent = parseAgent(
      '---\nname: lead\ntools: read, subagent\n---\nLead.',
      '/repo/agents/lead.md',
      'global',
    );
    expect(agentToolEntries(agent, ['read', 'subagent'])).toEqual(['read', 'subagent']);
    expect(agentToolEntries(agent, ['read', 'subagent', 'hc_subagent'])).toEqual([
      'read',
      'subagent',
      'hc_subagent',
      'hc_renew',
      'hc_read',
      'hc_stop',
      'hc_rm',
      'hc_send',
      'hc_agents',
    ]);
  });

  test('removes the blocking and Herdr delegation tools for a maxDepth: 0 agent', () => {
    expect(
      withoutDelegationTools([
        'read',
        'subagent',
        'hc_subagent',
        'hc_renew',
        'hc_read',
        'hc_stop',
        'hc_rm',
        'hc_send',
        'hc_agents',
      ]),
    ).toEqual(['read', 'hc_send', 'hc_agents']);
  });

  test('previews the shared profile before the first turn', () => {
    const base =
      'Default\n\n<project_context>\nProject rules.\n</project_context>\n\n<cwd>\n/repo\n</cwd>';
    const input = {
      cwd: '/repo',
      contextFiles: [{ path: 'AGENTS.md', content: 'Project rules.' }],
      appendSystemPrompt: 'Existing instructions.',
      selectedTools: ['read'],
      toolSnippets: { read: 'Read files.' },
    };
    for (const mode of ['append', 'replace', 'replace-all']) {
      const agent = parseAgent(
        `---\nname: reviewer\nsystemPrompt: ${mode}\n---\nReview code.`,
        '/reviewer.md',
      );
      const prompt = previewAgentPrompt(agent, base, input);
      expect(prompt).toContain('Review code.');
      expect(prompt).toContain('Existing instructions.');
      expect(prompt.includes('Project rules.')).toBe(mode !== 'replace-all');
      expect(prompt.includes('Available tools:')).toBe(mode !== 'append');
    }
  });

  test('preserves leading indentation while dropping extra blank lines after frontmatter', () => {
    const agent = parseAgent(
      `---
name: indented
thinking: off
---


    indented first line
Second line.
`,
      '/repo/agents/indented.md',
      'global',
    );

    expect(agent.prompt).toBe('    indented first line\nSecond line.\n');
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
