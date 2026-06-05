import * as os from 'node:os';
import {
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  keyHint,
  type ExtensionAPI,
  type GrepToolDetails,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

interface TextBlock {
  type: string;
  text?: string;
}

interface ToolResultLike {
  content: TextBlock[];
  details?: unknown;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function sanitizeDisplayText(value: string): string {
  return Array.from(stripAnsi(value))
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join('')
    .replace(/\r/g, '');
}

function getTextOutput(result: ToolResultLike): string {
  return result.content
    .filter((content) => content.type === 'text' && typeof content.text === 'string')
    .map((content) => sanitizeDisplayText(content.text ?? ''))
    .join('\n')
    .trim();
}

function stringArg(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return null;
}

function shortenPath(value: string): string {
  const home = os.homedir();
  if (value.startsWith(home)) return `~${value.slice(home.length)}`;
  return value;
}

function invalidArgText(theme: Theme): string {
  return theme.fg('error', '[invalid arg]');
}

function renderGrepCall(args: Record<string, unknown> | undefined, theme: Theme): string {
  const pattern = stringArg(args?.pattern);
  const rawPath = stringArg(args?.path);
  const path = rawPath !== null ? shortenPath(rawPath || '.') : null;
  const glob = stringArg(args?.glob);
  const limit = args?.limit;
  const invalidArg = invalidArgText(theme);

  let text =
    theme.fg('toolTitle', theme.bold('grep')) +
    ' ' +
    (pattern === null ? invalidArg : theme.fg('syntaxKeyword', `/${pattern || ''}/`)) +
    theme.fg('dim', ' in ') +
    (path === null ? invalidArg : theme.fg('accent', path));

  if (glob) {
    text += theme.fg('muted', ` (${glob})`);
  }
  if (limit !== undefined) {
    text += theme.fg('toolOutput', ` limit ${limit}`);
  }

  return text;
}

function renderGrepLine(line: string, theme: Theme): string {
  const matchLine = /^(.+):(\d+): (.*)$/.exec(line);
  if (matchLine) {
    const filePath = matchLine[1] ?? '';
    const lineNumber = matchLine[2] ?? '';
    const content = matchLine[3] ?? '';
    return (
      theme.fg('accent', filePath) +
      theme.fg('dim', ':') +
      theme.fg('syntaxNumber', lineNumber) +
      theme.fg('dim', ':') +
      theme.fg('toolOutput', ` ${content}`)
    );
  }

  const contextLine = /^(.+)-(\d+)- (.*)$/.exec(line);
  if (contextLine) {
    const filePath = contextLine[1] ?? '';
    const lineNumber = contextLine[2] ?? '';
    const content = contextLine[3] ?? '';
    return (
      theme.fg('syntaxFunction', filePath) +
      theme.fg('dim', '-') +
      theme.fg('syntaxNumber', lineNumber) +
      theme.fg('dim', '-') +
      theme.fg('toolOutput', ` ${content}`)
    );
  }

  return theme.fg('toolOutput', line);
}

function renderTruncationWarning(details: GrepToolDetails | undefined, theme: Theme): string {
  const warnings: string[] = [];

  if (details?.matchLimitReached) {
    warnings.push(`${details.matchLimitReached} matches limit`);
  }
  if (details?.truncation?.truncated) {
    warnings.push(`${formatSize(details.truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
  }
  if (details?.linesTruncated) {
    warnings.push('some lines truncated');
  }

  if (warnings.length === 0) return '';
  return `\n${theme.fg('warning', `[Truncated: ${warnings.join(', ')}]`)}`;
}

export const __testing = {
  getTextOutput,
  invalidArgText,
  renderGrepCall,
  renderGrepLine,
  renderTruncationWarning,
  sanitizeDisplayText,
  shortenPath,
  stripAnsi,
  stringArg,
};

function registerGrepHighlightTool(pi: ExtensionAPI, cwd: string): void {
  const grep = createGrepToolDefinition(cwd);

  pi.registerTool({
    ...grep,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tool = createGrepToolDefinition(ctx?.cwd ?? cwd);
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);
      component.setText(renderGrepCall(args as Record<string, unknown> | undefined, theme));
      return component;
    },

    renderResult(result, options, theme, context) {
      const output = getTextOutput(result as ToolResultLike);
      let text = '';

      if (output) {
        const lines = output.split('\n');
        const maxLines = options.expanded ? lines.length : 15;
        const displayLines = lines.slice(0, maxLines);
        const remaining = lines.length - maxLines;

        text += `\n${displayLines.map((line) => renderGrepLine(line, theme)).join('\n')}`;

        if (remaining > 0) {
          text += `${theme.fg('muted', `\n... (${remaining} more lines,`)} ${keyHint(
            'app.tools.expand',
            'to expand',
          )})`;
        }
      }

      text += renderTruncationWarning(result.details as GrepToolDetails | undefined, theme);

      const component = (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);
      component.setText(text);
      return component;
    },
  });
}

export default function (pi: ExtensionAPI): void {
  const cwd = process.cwd();

  // Register after pi has created the built-in tool registry. If this override is
  // registered during extension load, pi treats it as a new extension tool and
  // enables it by default. Delaying registration preserves the built-in grep
  // active/inactive state while still replacing grep once the user enables it.
  pi.on('session_start', () => {
    registerGrepHighlightTool(pi, cwd);
  });
}
