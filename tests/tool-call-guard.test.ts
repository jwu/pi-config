import { describe, expect, test } from 'bun:test';
import toolCallGuardExtension, { findGrepCommand } from '../extensions/tool-call-guard.ts';

describe('findGrepCommand', () => {
  test('matches grep as the command', () => {
    expect(findGrepCommand('grep -rn foo src/')).toBe('grep');
    expect(findGrepCommand('grep')).toBe('grep');
    expect(findGrepCommand('/usr/bin/grep foo')).toBe('/usr/bin/grep');
    expect(findGrepCommand('FOO=1 grep foo')).toBe('grep');
  });

  test('matches grep after pipes, operators, subshells and command substitution', () => {
    expect(findGrepCommand('cat a.txt | grep -c foo')).toBe('grep');
    expect(findGrepCommand('git log | grep fix')).toBe('grep');
    expect(findGrepCommand('ls && grep x f')).toBe('grep');
    expect(findGrepCommand('(grep x f)')).toBe('grep');
    expect(findGrepCommand('echo $(grep x f)')).toBe('grep');
    expect(findGrepCommand('if grep -q x f; then echo y; fi')).toBe('grep');
    expect(findGrepCommand('while grep -q x f; do :; done')).toBe('grep');
  });

  test('matches grep behind wrapper commands that really run it', () => {
    expect(findGrepCommand('sudo grep foo /etc/hosts')).toBe('grep');
    expect(findGrepCommand('command grep foo')).toBe('grep');
    expect(findGrepCommand('xargs grep foo')).toBe('grep');
    expect(findGrepCommand('find . -name "*.rs" -exec grep x {} +')).toBe('grep');
  });

  test('allows rg and git grep', () => {
    expect(findGrepCommand('rg -n foo src/')).toBeNull();
    expect(findGrepCommand('git grep -n -- --shot')).toBeNull();
    expect(findGrepCommand('cd repo && git grep foo')).toBeNull();
  });

  test('ignores quoted literals, arguments and lookalike names', () => {
    expect(findGrepCommand("rg 'grep' src/")).toBeNull();
    expect(findGrepCommand('echo "grep -rn foo"')).toBeNull();
    expect(findGrepCommand('printf grep')).toBeNull();
    expect(findGrepCommand('ls grep/')).toBeNull();
    expect(findGrepCommand('grepfile foo')).toBeNull();
    expect(findGrepCommand('echo grep -rn foo')).toBeNull();
  });
});

describe('tool-call-guard extension', () => {
  const load = () => {
    let handler: ((event: unknown) => unknown) | undefined;
    const pi = {
      on: (eventName: string, cb: typeof handler) => {
        expect(eventName).toBe('tool_call');
        handler = cb;
      },
    };
    toolCallGuardExtension(pi as never);
    return handler!;
  };

  test('blocks a grep command in the bash tool', () => {
    const result = load()({ toolName: 'bash', input: { command: 'grep -rn foo .' } });
    expect(result).toMatchObject({ block: true });
  });

  test('lets rg, git grep and unrelated tools through', () => {
    const handler = load();
    expect(handler({ toolName: 'bash', input: { command: 'rg -n foo src/' } })).toBeUndefined();
    expect(handler({ toolName: 'bash', input: { command: 'git grep foo' } })).toBeUndefined();
    expect(handler({ toolName: 'read', input: { path: 'a.txt' } })).toBeUndefined();
    expect(handler({ toolName: 'bash', input: {} })).toBeUndefined();
    expect(handler({ toolName: 'bash', input: { command: 42 } })).toBeUndefined();
  });
});
