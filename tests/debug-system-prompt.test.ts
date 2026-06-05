import { describe, expect, test } from 'bun:test';
import { __testing } from '../extensions/debug-system-prompt.ts';

const { getPiTerminalTitle, getSystemPrompt } = __testing;
const bridgeSymbol = Symbol.for('pi-config.custom-agent.systemPromptBridge');

describe('debug-system-prompt helpers', () => {
  test('uses custom-agent prompt bridge when present', () => {
    const globalWithBridge = globalThis as typeof globalThis & {
      [bridgeSymbol]?: {
        getPrompt?: (
          basePrompt: string,
          options?: { selectedTools?: string[] },
        ) => string | undefined;
      };
    };
    const previous = globalWithBridge[bridgeSymbol];
    globalWithBridge[bridgeSymbol] = { getPrompt: (basePrompt) => `${basePrompt}\ncustom` };

    try {
      expect(getSystemPrompt('base')).toBe('base\ncustom');
    } finally {
      globalWithBridge[bridgeSymbol] = previous;
    }
  });

  test('passes system prompt options to custom-agent prompt bridge', () => {
    const globalWithBridge = globalThis as typeof globalThis & {
      [bridgeSymbol]?: {
        getPrompt?: (
          basePrompt: string,
          options?: { selectedTools?: string[] },
        ) => string | undefined;
      };
    };
    const previous = globalWithBridge[bridgeSymbol];
    globalWithBridge[bridgeSymbol] = {
      getPrompt: (basePrompt, options) =>
        `${basePrompt}\ntools:${options?.selectedTools?.join(',') ?? 'none'}`,
    };

    try {
      expect(getSystemPrompt('base', { selectedTools: ['read', 'subagent'], cwd: '/tmp' })).toBe(
        'base\ntools:read,subagent',
      );
    } finally {
      globalWithBridge[bridgeSymbol] = previous;
    }
  });

  test('falls back to base prompt without bridge', () => {
    const globalWithBridge = globalThis as typeof globalThis & {
      [bridgeSymbol]?: {
        getPrompt?: (
          basePrompt: string,
          options?: { selectedTools?: string[] },
        ) => string | undefined;
      };
    };
    const previous = globalWithBridge[bridgeSymbol];
    delete globalWithBridge[bridgeSymbol];

    try {
      expect(getSystemPrompt('base')).toBe('base');
    } finally {
      globalWithBridge[bridgeSymbol] = previous;
    }
  });

  test('formats terminal title with optional session name', () => {
    const ctx = {
      sessionManager: {
        getCwd: () => '/tmp/project',
        getSessionName: () => 'agent:scout',
      },
    };

    expect(getPiTerminalTitle(ctx as never)).toBe('π - agent:scout - project');

    const unnamedCtx = {
      sessionManager: {
        getCwd: () => '/tmp/project',
        getSessionName: () => '',
      },
    };
    expect(getPiTerminalTitle(unnamedCtx as never)).toBe('π - project');
  });
});
