import { afterEach, describe, expect, test } from 'bun:test';
import init, { __testing } from '../extensions/terminal-signals.ts';

const { progressKeepaliveMs } = __testing;

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

function createHarness({ tty = true, cwd = '/repo/project' } = {}) {
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
