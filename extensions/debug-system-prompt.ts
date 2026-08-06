/**
 * /debug-system-prompt command - preview the current system prompt
 *
 * Opens the current system prompt in the user's external editor ($EDITOR / $VISUAL).
 * The editor session is read-only for preview; changes are discarded.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';

interface CustomAgentSystemPromptBridge {
  getPrompt?: (basePrompt: string, options?: BuildSystemPromptOptions) => string | undefined;
}

const SYSTEM_PROMPT_BRIDGE = Symbol.for('pi-config.custom-agent.systemPromptBridge');
const systemPromptBridge = globalThis as typeof globalThis & {
  [SYSTEM_PROMPT_BRIDGE]?: CustomAgentSystemPromptBridge;
};

function getSystemPrompt(basePrompt: string, options?: BuildSystemPromptOptions): string {
  return systemPromptBridge[SYSTEM_PROMPT_BRIDGE]?.getPrompt?.(basePrompt, options) ?? basePrompt;
}

function writeTerminalControl(sequence: string): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(sequence);
}

function getPiTerminalTitle(ctx: ExtensionCommandContext): string {
  const cwdBasename = path.basename(ctx.sessionManager.getCwd());
  const sessionName = ctx.sessionManager.getSessionName();
  return sessionName ? `π - ${sessionName} - ${cwdBasename}` : `π - ${cwdBasename}`;
}

export const __testing = {
  getPiTerminalTitle,
  getSystemPrompt,
  writeTerminalControl,
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand('debug-system-prompt', {
    description: 'Preview the current system prompt in external editor',
    handler: async (_args, ctx) => {
      const prompt = getSystemPrompt(ctx.getSystemPrompt(), ctx.getSystemPromptOptions());
      if (!prompt) {
        ctx.ui.notify("No system prompt available. The agent hasn't started yet.", 'info');
        return;
      }

      const editorCmd = process.env.VISUAL || process.env.EDITOR;
      if (!editorCmd) {
        ctx.ui.notify('No external editor configured ($VISUAL or $EDITOR not set)', 'error');
        return;
      }

      const lines = prompt.split('\n').length;
      const tmpFile = path.join(os.tmpdir(), `pi-system-prompt-${Date.now()}.md`);
      const header = `System Prompt Preview — ${lines} lines, ${prompt.length} chars (read-only)\n\n`;
      fs.writeFileSync(tmpFile, header + prompt, 'utf-8');

      try {
        if (!ctx.hasUI) {
          ctx.ui.notify('debug-system-prompt requires interactive mode', 'error');
          return;
        }

        await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
          const component = {
            render: () => ['Opening system prompt in external editor...'],
            invalidate: () => {},
          };

          setImmediate(async () => {
            try {
              // Save the terminal title before nvim/vim can change it. Ghostty honors
              // xterm's title stack, and we also set Pi's title explicitly on return.
              writeTerminalControl('\x1b[22;0t');

              // Release pi's TUI before handing the terminal to the external editor.
              tui.stop();

              const [editor, ...editorArgs] = editorCmd.split(' ');
              await new Promise<void>((resolve) => {
                const child = spawn(editor, [...editorArgs, tmpFile], {
                  stdio: 'inherit',
                  shell: process.platform === 'win32',
                });
                child.on('error', () => resolve());
                child.on('close', () => resolve());
              });
            } finally {
              // Restore the saved terminal title, then explicitly restore Pi's own
              // title as a fallback for terminals/editors that do not use the stack.
              writeTerminalControl('\x1b[23;0t');
              ctx.ui.setTitle(getPiTerminalTitle(ctx));

              // Restore pi's TUI and force a full repaint because editors commonly
              // use alternate screen / resize-sensitive terminal state.
              tui.start();
              done();
              tui.requestRender(true);
            }
          });

          return component;
        });
      } finally {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          // ignore cleanup errors
        }
      }
    },
  });
}
