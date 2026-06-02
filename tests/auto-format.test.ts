import { describe, expect, test } from 'bun:test';
import autoFormatExtension from '../extensions-optional/auto-format.ts';

describe('auto-format extension', () => {
  test('registers tool_result handler and formats successful TypeScript edits', async () => {
    let handler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const execCalls: unknown[] = [];
    const pi = {
      on: (eventName: string, cb: typeof handler) => {
        expect(eventName).toBe('tool_result');
        handler = cb;
      },
      exec: async (...args: unknown[]) => {
        execCalls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    };

    autoFormatExtension(pi as never);
    await handler?.(
      { isError: false, toolName: 'edit', input: { path: 'extensions/read.ts' } },
      { cwd: '/repo', signal: undefined, ui: { notify: () => {} } },
    );

    expect(execCalls).toEqual([
      ['bun', ['prettier', '--write', 'extensions/read.ts'], { cwd: '/repo', signal: undefined }],
    ]);
  });

  test('ignores errors, unrelated tools, and non-TypeScript files', async () => {
    let handler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      on: (_eventName: string, cb: typeof handler) => {
        handler = cb;
      },
      exec: async () => {
        throw new Error('should not run');
      },
    };

    autoFormatExtension(pi as never);
    const ctx = { cwd: '/repo', signal: undefined, ui: { notify: () => {} } };
    await handler?.({ isError: true, toolName: 'edit', input: { path: 'a.ts' } }, ctx);
    await handler?.({ isError: false, toolName: 'read', input: { path: 'a.ts' } }, ctx);
    await handler?.({ isError: false, toolName: 'write', input: { path: 'README.md' } }, ctx);
  });

  test('notifies when prettier exits non-zero', async () => {
    let handler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const notifications: string[] = [];
    const pi = {
      on: (_eventName: string, cb: typeof handler) => {
        handler = cb;
      },
      exec: async () => ({ code: 2, stdout: '', stderr: 'bad format\n' }),
    };

    autoFormatExtension(pi as never);
    await handler?.(
      { isError: false, toolName: 'write', input: { path: 'a.ts' } },
      {
        cwd: '/repo',
        signal: undefined,
        ui: { notify: (message: string) => notifications.push(message) },
      },
    );

    expect(notifications).toEqual(['Prettier failed for a.ts: bad format']);
  });
});
