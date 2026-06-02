/**
 * /show-system-prompt command - preview the current system prompt
 *
 * Opens the current system prompt in the user's external editor ($EDITOR / $VISUAL).
 * The editor session is read-only for preview; changes are discarded.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface CustomAgentSystemPromptBridge {
  getPrompt?: (basePrompt: string) => string | undefined;
}

const SYSTEM_PROMPT_BRIDGE = Symbol.for("pi-config.custom-agent.systemPromptBridge");
const systemPromptBridge = globalThis as typeof globalThis & {
  [SYSTEM_PROMPT_BRIDGE]?: CustomAgentSystemPromptBridge;
};

function getSystemPrompt(basePrompt: string): string {
  return systemPromptBridge[SYSTEM_PROMPT_BRIDGE]?.getPrompt?.(basePrompt) ?? basePrompt;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("show-system-prompt", {
    description: "Preview the current system prompt in external editor",
    handler: async (_args, ctx) => {
      const prompt = getSystemPrompt(ctx.getSystemPrompt());
      if (!prompt) {
        ctx.ui.notify("No system prompt available. The agent hasn't started yet.", "info");
        return;
      }

      const editorCmd = process.env.VISUAL || process.env.EDITOR;
      if (!editorCmd) {
        ctx.ui.notify("No external editor configured ($VISUAL or $EDITOR not set)", "error");
        return;
      }

      const lines = prompt.split("\n").length;
      const tmpFile = path.join(os.tmpdir(), `pi-system-prompt-${Date.now()}.md`);
      const header = `System Prompt Preview — ${lines} lines, ${prompt.length} chars (read-only)\n\n`;
      fs.writeFileSync(tmpFile, header + prompt, "utf-8");

      try {
        if (!ctx.hasUI) {
          ctx.ui.notify("show-system-prompt requires interactive mode", "error");
          return;
        }

        await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
          const component = {
            render: () => ["Opening system prompt in external editor..."],
            invalidate: () => {},
          };

          setImmediate(async () => {
            try {
              // Release pi's TUI before handing the terminal to the external editor.
              tui.stop();

              const [editor, ...editorArgs] = editorCmd.split(" ");
              await new Promise<void>((resolve) => {
                const child = spawn(editor, [...editorArgs, tmpFile], {
                  stdio: "inherit",
                  shell: process.platform === "win32",
                });
                child.on("error", () => resolve());
                child.on("close", () => resolve());
              });
            } finally {
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
