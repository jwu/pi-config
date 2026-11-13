/**
 * clipboard-osc52
 *
 * Makes pi's clipboard writes reach the terminal's own clipboard too.
 *
 * pi copies into the *local* clipboard of the machine it runs on (wl-copy,
 * xclip/xsel, pbcopy). When pi runs remotely — herdr, ssh, mosh — that is the
 * wrong clipboard: the "Copied!" flash is honest, but the client machine
 * pastes the old contents.
 *
 * PI_CLIPBOARD_OSC52=1 makes pi treat the session as remote and emit the text
 * as OSC 52 as well. Terminals that support it (herdr, Ghostty, WezTerm, iTerm2,
 * kitty, Windows Terminal, VS Code) put it on the clipboard of the machine that
 * shows them; others ignore the sequence.
 *
 * The extra write only happens for interactive sessions: a pi run with piped
 * stdout must not spray escape sequences into the output.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

if (process.stdout.isTTY) {
  process.env.PI_CLIPBOARD_OSC52 = '1';
}

export default function clipboardOsc52(_pi: ExtensionAPI): void {}
