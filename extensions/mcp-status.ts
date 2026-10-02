/**
 * MCP footer status.
 *
 * pi-mcp-adapter published `MCP <connected>/<configured>` through `ctx.ui.setStatus('mcp', ...)`,
 * tinted with the theme's `accent` colour, which pi-powerline fuses into the right side of the
 * footer stats line. The built-in MCP extension writes no footer status at all, so this extension
 * fills that gap: it counts the `mcp__*` namespaces among the registered tools and the enabled
 * servers in `mcp.json`, then publishes the same `mcp` key with the same tint. pi-powerline
 * therefore needs no change.
 *
 * Servers connect asynchronously, so the status is refreshed on session start, on every turn, and
 * on a slow timer. Set `MCP_STATUS_DEBUG=1` to trace the decisions on stderr.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Status key pi-powerline reads for the segment it fuses into the stats line. */
const STATUS_KEY = 'mcp';

/** Servers connect in the background; poll until they do, then keep the timer cheap. */
const REFRESH_MS = 2000;

const DEBUG = process.env.MCP_STATUS_DEBUG === '1';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[mcp-status]', ...args);
}

/** Tool namespaces replace every character outside `[A-Za-z0-9_]` with `_`, e.g. `mcp__comfy_mcp`. */
function toNamespace(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** `mcpServers` entries of one `mcp.json` as `[name, enabled]` pairs. Empty when unreadable. */
function readServerEntries(path: string): Array<[string, boolean]> {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      mcpServers?: Record<string, { enabled?: boolean } | undefined>;
    };
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') return [];
    return Object.entries(servers).map(([name, config]) => [name, config?.enabled !== false]);
  } catch (error) {
    log(`cannot read ${path}:`, error);
    return [];
  }
}

/**
 * Enabled servers of the session: the user file first, then the project file, which overrides a
 * user entry with the same name (matching how pi resolves `mcp.json`).
 */
function enabledServers(cwd: string): string[] {
  const effective = new Map<string, boolean>();
  const sources = [join(homedir(), '.pi', 'agent', 'mcp.json'), join(cwd, '.pi', 'mcp.json')];
  for (const path of sources) {
    for (const [name, enabled] of readServerEntries(path)) effective.set(name, enabled);
  }
  return [...effective].filter(([, enabled]) => enabled).map(([name]) => name);
}

/** `MCP <connected>/<configured>`, or undefined when the session configures no server. */
function statusText(pi: ExtensionAPI, cwd: string): string | undefined {
  const configured = enabledServers(cwd);
  if (configured.length === 0) return undefined;

  const namespaces = new Set(
    pi
      .getAllTools()
      .map((tool) => tool.namespace?.name)
      .filter((name): name is string => !!name && name.startsWith('mcp__')),
  );
  const connected = configured.filter((name) => namespaces.has(toNamespace(name)));
  return `MCP ${connected.length}/${configured.length}`;
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let last: string | undefined;
  let current: ExtensionContext | undefined;

  const refresh = (): void => {
    const ctx = current;
    if (!ctx) return;
    try {
      const text = statusText(pi, ctx.cwd);
      // Match pi-mcp-adapter: the footer text carried the theme's accent colour, and
      // pi-powerline passes ANSI through untouched.
      const theme = ctx.ui?.theme;
      const styled =
        text !== undefined && typeof theme?.fg === 'function' ? theme.fg('accent', text) : text;
      if (styled === last) return;
      last = styled;
      ctx.ui?.setStatus?.(STATUS_KEY, styled);
      log(`status -> ${text ?? '(cleared)'}`);
    } catch (error) {
      log('refresh failed:', error);
    }
  };

  pi.on('session_start', (_event, ctx) => {
    current = ctx;
    last = undefined;
    refresh();
    if (!timer) {
      timer = setInterval(refresh, REFRESH_MS);
      timer.unref?.();
    }
  });

  pi.on('turn_start', (_event, ctx) => {
    current = ctx;
    refresh();
  });
}
