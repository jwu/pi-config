import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

// Check if running inside Ghostty on macOS
function isGhosttyOnMac(): boolean {
  if (platform() !== 'darwin') return false;
  return process.env.TERM_PROGRAM === 'ghostty';
}

// Escape a string for AppleScript string literal
function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildGhosttySplitScript(
  direction: 'right' | 'down',
  sessionFile: string,
  cwd: string,
): string {
  const escapedSessionFile = appleScriptEscape(sessionFile);
  const escapedCwd = appleScriptEscape(cwd);

  return `
tell application "Ghostty"
  set cfg to new surface configuration
  set initial working directory of cfg to "${escapedCwd}"
  set initial input of cfg to "pi --session \\"${escapedSessionFile}\\"" & return
  split (focused terminal of selected tab of front window) direction ${direction} with configuration cfg
end tell
`.trim();
}

// Build and execute AppleScript to split and run pi.
// Uses initialInput instead of command so the shell runs as a normal login
// shell (loads .bashrc/.zshrc, which initializes nvm and puts pi on PATH).
function ghosttySplit(direction: 'right' | 'down', sessionFile: string, cwd: string): void {
  execSync('osascript', {
    input: buildGhosttySplitScript(direction, sessionFile, cwd),
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

async function openSplit(
  ctx: ExtensionCommandContext,
  command: string,
  direction: 'right' | 'down',
): Promise<void> {
  if (!isGhosttyOnMac()) {
    ctx.ui.notify(
      `${command} requires Ghostty on macOS (TERM_PROGRAM=ghostty not detected)`,
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

  try {
    ghosttySplit(direction, sessionFile, ctx.cwd);
    ctx.ui.notify(
      `New pi split ${direction === 'down' ? 'below' : 'to the right'} with current session`,
      'info',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`${command} failed: ${msg}`, 'error');
  }
}

export const __testing = {
  appleScriptEscape,
  buildGhosttySplitScript,
  isGhosttyOnMac,
};

export default function (pi: ExtensionAPI) {
  // /split: new_split:down
  pi.registerCommand('split', {
    description: 'Open a new pi split below (Ghostty: new_split:down), loading current session',
    handler: async (_args, ctx) => openSplit(ctx, '/split', 'down'),
  });

  // /vsplit: new_split:right
  pi.registerCommand('vsplit', {
    description:
      'Open a new pi split to the right (Ghostty: new_split:right), loading current session',
    handler: async (_args, ctx) => openSplit(ctx, '/vsplit', 'right'),
  });
}
