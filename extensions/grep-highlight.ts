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

function renderGrepLine(line: string, theme: Theme): string {
  const matchLine = /^(.+):(\d+): (.*)$/.exec(line);
  if (matchLine) {
    const filePath = matchLine[1] ?? '';
    const lineNumber = matchLine[2] ?? '';
    const content = matchLine[3] ?? '';
    return (
      theme.fg('syntaxFunction', filePath) +
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

export default function (pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const grep = createGrepToolDefinition(cwd);

  pi.registerTool({
    ...grep,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tool = createGrepToolDefinition(ctx?.cwd ?? cwd);
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
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
