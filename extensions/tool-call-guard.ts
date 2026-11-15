import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Guard for bash tool calls: currently it only blocks grep.
 *
 * Motivation: a bare `grep -r` ignores .gitignore, so in a workspace with an 86 GB
 * `target/` it can scan for tens of minutes (we hit 20-39 minutes twice). `git grep`
 * and `rg` only read tracked or non-ignored files, so they pass through. Add further
 * command-level rules to this file.
 */
const REASON =
  'Do not use grep in bash: use the grep tool, or rg for counting and filtering ' +
  "(e.g. rg -n -- '--shot' src/). A bare grep -r also scans target/ and once took 20-39 minutes.";

/** Command separators: pipes, operators, subshells, backticks, newlines, and `$` from substitution. */
const SEGMENT_SPLIT = /[\n;|&()`$]+/;
/** A segment may start with these keywords or reserved words; the real command comes after. */
const LEADING_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  'done',
  'fi',
  '!',
  '{',
  '}',
  'time',
]);
/** Prefix commands that run another command with arguments: a grep inside them really executes. */
const WRAPPERS = new Set([
  'command',
  'exec',
  'sudo',
  'doas',
  'env',
  'nohup',
  'nice',
  'xargs',
  'find',
  'watch',
  'timeout',
  'builtin',
]);

/** File-name part of a command token: `/usr/bin/grep` becomes `grep`. */
function basename(token: string): string {
  return token.split('/').pop() ?? token;
}

/**
 * Blank out quoted text so `rg 'grep'` or `echo "grep"` is not blocked for using grep
 * as a literal. This is an approximation: heredocs, escaped quotes, and multi-line
 * strings are not expanded.
 */
function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** Returns the matched command token when grep runs as a command, otherwise null. */
export function findGrepCommand(command: string): string | null {
  for (const segment of stripQuoted(command).split(SEGMENT_SPLIT)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (
      i < tokens.length &&
      (LEADING_KEYWORDS.has(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))
    ) {
      i += 1;
    }
    if (i >= tokens.length) continue;

    const head = basename(tokens[i]);
    // git subcommands, including git grep, only read tracked files; leave them to git.
    if (head === 'git') continue;
    if (head === 'grep') return tokens[i];
    if (!WRAPPERS.has(head)) continue;

    // Only a grep behind a wrapper command actually executes; plain arguments stay allowed.
    const nested = tokens.slice(i + 1).find((token) => basename(token) === 'grep');
    if (nested) return nested;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', (event) => {
    if (event.toolName !== 'bash') return;
    const input = event.input as { command?: unknown } | undefined;
    const command = typeof input?.command === 'string' ? input.command : undefined;
    if (!command) return;
    if (!findGrepCommand(command)) return;
    return { block: true, reason: REASON };
  });
}
