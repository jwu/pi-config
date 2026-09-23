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
  SessionBeforeSwitchEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { basename } from 'node:path';

// ─── OSC escape sequences ────────────────────────────────────────────

const OSC = '\x1b]';
const BEL = '\x07';

function writeOSC(sequence: string) {
  if (!process.stdout.isTTY) return;
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

/**
 * How often to re-send OSC 9;4;3 while the agent is active. Ghostty dismisses
 * the progress indicator 15 s after the last report, so it has to be re-sent
 * either way; how often depends on how the platform animates it.
 *
 *   - macOS: the bar animates its indeterminate state on its own, so incoming
 *     reports only refresh the "still busy" state. A rare keepalive is enough.
 *
 *   - Linux: Ghostty's GTK backend advances the bar by calling
 *     gtk_progress_bar_pulse() only when an OSC 9;4;3 arrives — GTK has no
 *     internal timer. A slow keepalive therefore makes the bar crawl, one step
 *     per report. Pulse frequently to animate it smoothly.
 */
export function progressKeepaliveMs(platform: NodeJS.Platform = process.platform): number {
  return platform === 'linux' ? 50 : 10_000;
}

const PROGRESS_INTERVAL_MS = progressKeepaliveMs();

// ─── Title spinner ───────────────────────────────────────────────────

const TITLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TITLE_SPINNER_INTERVAL_MS = 80;

// ─── Extension ───────────────────────────────────────────────────────

export const __testing = {
  progressKeepaliveMs,
};

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

  pi.on(
    'session_before_switch',
    async (_event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => {
      ensureStopped(ctx);
    },
  );
}
