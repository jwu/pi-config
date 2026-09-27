import { afterEach, describe, expect, test } from 'bun:test';
import os from 'node:os';
import init, { __testing } from '../extensions/terminal-signals.ts';

const { progressKeepaliveMs, sshTag } = __testing;

const PROGRESS_ACTIVE = '\u001b]9;4;3\u0007';
const PROGRESS_CLEAR = '\u001b]9;4;0\u0007';
const COMMAND_DONE = '\u001b]133;D;0\u0007';

const realWrite = process.stdout.write.bind(process.stdout);
const realIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

type Handler = (event: unknown, ctx: unknown) => unknown;

let current: ReturnType<typeof createHarness> | undefined;

afterEach(async () => {
  // Stop any interval a failing test left running, then restore stdout.
  await current?.fire('session_shutdown');
  current = undefined;
  process.stdout.write = realWrite;
  if (realIsTTY) {
    Object.defineProperty(process.stdout, 'isTTY', realIsTTY);
  } else {
    delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});

function createHarness({
  tty = true,
  cwd = '/repo/project',
  env = {} as Record<string, string>,
} = {}) {
  // The ssh tag is captured at init, so isolate the ssh env around init only.
  const savedEnv = {
    SSH_CONNECTION: process.env.SSH_CONNECTION,
    SSH_TTY: process.env.SSH_TTY,
  };
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  Object.assign(process.env, env);

  const writes: string[] = [];
  const titles: string[] = [];
  const handlers = new Map<string, Handler>();

  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  process.stdout.write = ((data: unknown) => {
    writes.push(String(data));
    return true;
  }) as typeof process.stdout.write;

  init({
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => {};
    },
  } as never);

  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  if (savedEnv.SSH_CONNECTION !== undefined) process.env.SSH_CONNECTION = savedEnv.SSH_CONNECTION;
  if (savedEnv.SSH_TTY !== undefined) process.env.SSH_TTY = savedEnv.SSH_TTY;

  const ctx = {
    hasUI: true,
    cwd,
    ui: { setTitle: (title: string) => titles.push(title) },
  };

  const harness = {
    writes,
    titles,
    fire: async (event: string): Promise<void> => {
      await handlers.get(event)?.(undefined, ctx);
    },
  };

  current = harness;
  return harness;
}

describe('terminal-signals progress keepalive', () => {
  test('pulses fast on Linux and rarely elsewhere', () => {
    expect(progressKeepaliveMs('linux')).toBe(50);
    expect(progressKeepaliveMs('darwin')).toBe(10_000);
    expect(progressKeepaliveMs('win32')).toBe(10_000);
  });
});

describe('terminal-signals OSC lifecycle', () => {
  test('marks indeterminate progress on agent start and clears it on agent end', async () => {
    const h = createHarness();

    await h.fire('agent_start');
    expect(h.writes[0]).toBe(PROGRESS_ACTIVE);

    await h.fire('agent_end');
    expect(h.writes.slice(-2)).toEqual([PROGRESS_CLEAR, COMMAND_DONE]);
  });

  test('clears progress on session shutdown and session switch', async () => {
    for (const event of ['session_shutdown', 'session_before_switch']) {
      const h = createHarness();
      await h.fire('agent_start');
      await h.fire(event);
      expect(h.writes.slice(-2)).toEqual([PROGRESS_CLEAR, COMMAND_DONE]);
    }
  });

  test('animates the tab title while active and restores it when idle', async () => {
    const h = createHarness({ cwd: '/repo/project' });

    await h.fire('session_start');
    expect(h.titles[0]).toBe('π - project');

    await h.fire('agent_start');
    expect(h.titles.at(-1)).toBe('⠋ π - project');

    await h.fire('agent_end');
    expect(h.titles.at(-1)).toBe('π - project');
  });

  test('stays silent on a non-TTY stdout', async () => {
    const h = createHarness({ tty: false });

    await h.fire('agent_start');
    await h.fire('agent_end');

    expect(h.writes).toEqual([]);
    expect(h.titles.at(-1)).toBe('π - project');
  });
});

describe('terminal-signals ssh tag', () => {
  test('is empty outside ssh and names the host inside', () => {
    expect(sshTag({}, 'macmini')).toBe('');
    expect(sshTag({ SSH_CONNECTION: '10.0.0.1 5 10.0.0.2 22' }, 'macmini')).toBe('🖥 macmini ');
    expect(sshTag({ SSH_TTY: '/dev/pts/0' }, 'macmini')).toBe('🖥 macmini ');
  });

  test('prefixes the title inside an ssh session', async () => {
    const h = createHarness({ env: { SSH_CONNECTION: '10.0.0.1 5 10.0.0.2 22' } });

    await h.fire('session_start');
    expect(h.titles[0]).toBe(`🖥 ${os.hostname()} π - project`);

    await h.fire('agent_start');
    expect(h.titles.at(-1)).toBe(`⠋ 🖥 ${os.hostname()} π - project`);
  });

  test('re-asserts the title after pi core rewrites it', async () => {
    const h = createHarness();
    await h.fire('session_start');
    h.titles.length = 0;

    await h.fire('session_info_changed');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.titles).toEqual(['π - project']);
  });
});
