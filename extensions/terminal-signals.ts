/**
 * terminal-signals
 *
 * Communicates pi's agent lifecycle to the host terminal using standard
 * escape sequences, and animates the terminal tab title while running.
 *
 * OSC signals:
 *   - OSC 9;4;3 (indeterminate progress) on agent_start
 *   - OSC 9;4;0 (clear progress) on agent_end
 *   - OSC 133;D;0 (command finished successfully) on agent_end
 *
 * Title:
 *   - Spinner animation in tab title while agent is active
 *   - Idle title "π - <cwd>" when agent is idle
 *
 * Works across Ghostty, WezTerm, iTerm2, Kitty, Windows Terminal,
 * VS Code terminal, and others. All sequences are silently ignored by
 * terminals that don't support them.
 */

import type {
  AgentEndEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionSwitchEvent,
} from '@earendil-works/pi-coding-agent';
import { basename } from 'node:path';

// ─── OSC escape sequences ────────────────────────────────────────────

const OSC = '\x1b]';
const BEL = '\x07';

function writeOSC(sequence: string) {
  process.stdout.write(`${OSC}${sequence}${BEL}`);
}

/** OSC 9;4;3 = indeterminate progress (animated spinner on the tab). */
function startProgress() {
  writeOSC('9;4;3');
}

/** OSC 9;4;0 = clear / remove progress indicator. */
function stopProgress() {
  writeOSC('9;4;0');
}

/**
 * OSC 133;D;0 = command finished with exit code 0 (success).
 * Ghostty uses this to trigger tab completion notifications.
 *
 * We intentionally do NOT emit 133;A (prompt start) because pi is a
 * full-screen TUI — there is no prompt line in the scrollback.
 */
function markCommandDone() {
  writeOSC('133;D;0');
}

// Ghostty dismisses the progress indicator 15 s after the last OSC 9;4;3.
// Re-send every 10 s so the spinner stays visible during long agent runs.
const PROGRESS_INTERVAL_MS = 10_000;

// ─── Title spinner ───────────────────────────────────────────────────

const TITLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TITLE_SPINNER_INTERVAL_MS = 80;

// ─── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  let active = false;

  // OSC progress state
  let progressInterval: ReturnType<typeof setInterval> | null = null;

  // Title spinner state
  let frameIndex = 0;
  let titleInterval: ReturnType<typeof setInterval> | undefined;

  const cwdBase = (ctx: ExtensionContext): string => basename(ctx.cwd || 'pi');

  const setIdleTitle = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setTitle(`π - ${cwdBase(ctx)}`);
  };

  const setSpinnerTitle = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setTitle(`${TITLE_SPINNER_FRAMES[frameIndex]!} π - ${cwdBase(ctx)}`);
  };

  const stopTitleInterval = (): void => {
    if (titleInterval === undefined) return;
    clearInterval(titleInterval);
    titleInterval = undefined;
  };

  const ensureStarted = (ctx: ExtensionContext): void => {
    if (active) return;
    active = true;

    // Start OSC progress
    startProgress();
    progressInterval = setInterval(startProgress, PROGRESS_INTERVAL_MS);

    // Start title spinner
    frameIndex = 0;
    setSpinnerTitle(ctx);
    titleInterval = setInterval(() => {
      if (!active) {
        stopTitleInterval();
        return;
      }
      frameIndex = (frameIndex + 1) % TITLE_SPINNER_FRAMES.length;
      setSpinnerTitle(ctx);
    }, TITLE_SPINNER_INTERVAL_MS);
  };

  const ensureStopped = (ctx: ExtensionContext): void => {
    if (!active) return;
    active = false;

    // Stop OSC progress
    if (progressInterval !== null) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    stopProgress();
    markCommandDone();

    // Stop title spinner
    stopTitleInterval();
    setIdleTitle(ctx);
  };

  pi.on('session_start', async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    setIdleTitle(ctx);
  });

  pi.on('agent_start', async (_event: AgentStartEvent, ctx: ExtensionContext) => {
    ensureStarted(ctx);
  });

  pi.on('agent_end', async (_event: AgentEndEvent, ctx: ExtensionContext) => {
    ensureStopped(ctx);
  });

  pi.on('session_shutdown', async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    ensureStopped(ctx);
  });

  pi.on('session_switch', async (_event: SessionSwitchEvent, ctx: ExtensionContext) => {
    ensureStopped(ctx);
  });
}
