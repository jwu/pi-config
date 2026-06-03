/**
 * Animate the terminal tab title while Pi is running the agent loop.
 */
import type {
  AgentEndEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { basename } from 'node:path';

const TITLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TITLE_SPINNER_INTERVAL_MS = 80;

export default function (pi: ExtensionAPI): void {
  let active = false;
  let frameIndex = 0;
  let intervalId: ReturnType<typeof setInterval> | undefined;

  const cwdBase = (ctx: ExtensionContext): string => basename(ctx.cwd || 'pi');

  const setIdleTitle = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setTitle(`π - ${cwdBase(ctx)}`);
  };

  const setSpinnerTitle = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setTitle(`${TITLE_SPINNER_FRAMES[frameIndex]!} π - ${cwdBase(ctx)}`);
  };

  const stopInterval = (): void => {
    if (intervalId === undefined) return;
    clearInterval(intervalId);
    intervalId = undefined;
  };

  const ensureStarted = (ctx: ExtensionContext): void => {
    if (active) return;
    active = true;
    frameIndex = 0;
    setSpinnerTitle(ctx);
    intervalId = setInterval(() => {
      if (!active) {
        stopInterval();
        return;
      }
      frameIndex = (frameIndex + 1) % TITLE_SPINNER_FRAMES.length;
      setSpinnerTitle(ctx);
    }, TITLE_SPINNER_INTERVAL_MS);
  };

  const ensureStopped = (ctx: ExtensionContext): void => {
    if (!active) return;
    active = false;
    stopInterval();
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
}
