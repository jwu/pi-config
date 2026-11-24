import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

type Direction = 'right' | 'down';

interface HerdrTerminal {
  terminal: string;
  pane?: string | null;
}

interface HerdrLs {
  spaces?: { tabs?: { terminals?: HerdrTerminal[] }[] }[];
}

// Find the Herdr pane that shows this terminal in `herdr-app ls` output.
function findPane(ls: HerdrLs, terminal: string): string | null {
  for (const space of ls.spaces ?? []) {
    for (const tab of space.tabs ?? []) {
      for (const t of tab.terminals ?? []) {
        if (t.terminal === terminal && t.pane) return t.pane;
      }
    }
  }
  return null;
}

// The new pane runs pi through the user's interactive login shell, so .zshrc
// and friends put pi on PATH, and drops back to that shell when pi exits.
// cwd and the session file go in as positional args to avoid quoting them.
function buildSplitArgs(
  direction: Direction,
  pane: string,
  cwd: string,
  sessionFile: string,
  shell: string,
): string[] {
  const script = 'cd -- "$1" && pi --fork "$2"; exec "$0" -l';
  const payload = {
    direction,
    pane,
    argv: [shell, '-lic', script, shell, cwd, sessionFile],
  };
  return ['do', 'pane.split', JSON.stringify(payload)];
}

function herdrApp(args: string[]): string {
  return execFileSync('herdr-app', args, { encoding: 'utf-8', stdio: 'pipe' });
}

// `herdr-app do` reports failures as {"error": "..."} on stdout and exits 1.
function errorMessage(err: unknown): string {
  const stdout = (err as { stdout?: string }).stdout;
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      // fall through
    }
  }
  return err instanceof Error ? err.message : String(err);
}

async function openSplit(
  ctx: ExtensionCommandContext,
  command: string,
  direction: Direction,
): Promise<void> {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) {
    ctx.ui.notify(
      `${command} requires pi running in a Herdr terminal (HC_TERMINAL_ID not set)`,
      'error',
    );
    return;
  }

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    ctx.ui.notify(
      `No session file. ${command} requires a saved session (not --no-session mode).`,
      'error',
    );
    return;
  }
  // pi writes the file only after the first message; until then there's nothing to fork.
  if (!existsSync(sessionFile)) {
    ctx.ui.notify(`${command}: session not saved yet, send a message first`, 'error');
    return;
  }

  try {
    const pane = findPane(JSON.parse(herdrApp(['ls'])) as HerdrLs, terminal);
    if (!pane) {
      ctx.ui.notify(`${command}: terminal ${terminal} is not shown in a Herdr pane`, 'error');
      return;
    }
    const shell = process.env.SHELL || '/bin/sh';
    herdrApp(buildSplitArgs(direction, pane, ctx.cwd, sessionFile, shell));
    ctx.ui.notify(
      `Forked session into a new pi split ${direction === 'down' ? 'below' : 'to the right'}`,
      'info',
    );
  } catch (err: unknown) {
    ctx.ui.notify(`${command} failed: ${errorMessage(err)}`, 'error');
  }
}

export const __testing = {
  buildSplitArgs,
  errorMessage,
  findPane,
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand('split', {
    description: 'Fork the current session into a new pi split below (Herdr)',
    handler: async (_args, ctx) => openSplit(ctx, '/split', 'down'),
  });

  pi.registerCommand('vsplit', {
    description: 'Fork the current session into a new pi split to the right (Herdr)',
    handler: async (_args, ctx) => openSplit(ctx, '/vsplit', 'right'),
  });
}
