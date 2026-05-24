import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getLanguageFromPath,
  highlightCode,
  keyHint,
  type ExtensionAPI,
  type ReadToolDetails,
  type ReadToolInput,
  type Theme,
  type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

interface TextContentLike {
  type: 'text';
  text: string;
}

interface ImageContentLike {
  type: 'image';
  data?: string;
  mimeType?: string;
}

type ContentLike = TextContentLike | ImageContentLike;

interface ReadResultLike {
  content: ContentLike[];
  details?: ReadToolDetails;
}

interface ReadRenderContextLike {
  args: ReadToolInput;
  cwd: string;
  isError: boolean;
  showImages: boolean;
  lastComponent: unknown;
}

interface CompactReadClassification {
  kind: 'docs' | 'resource' | 'skill';
  label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']);
const PI_PACKAGE_ROOT = fileURLToPath(
  new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url),
);

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

function replaceTabs(text: string): string {
  return text.replace(/\t/g, '   ');
}

function getTextOutput(result: ReadResultLike, showImages: boolean): string {
  const text = result.content
    .filter((content): content is TextContentLike => content.type === 'text')
    .map((content) => sanitizeDisplayText(content.text))
    .join('\n');

  if (showImages) return text;

  const imageFallbacks = result.content
    .filter((content): content is ImageContentLike => content.type === 'image')
    .map((content) => `[Image: ${content.mimeType ?? 'image/unknown'}]`)
    .join('\n');

  if (!imageFallbacks) return text;
  return text ? `${text}\n${imageFallbacks}` : imageFallbacks;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') {
    end--;
  }
  return lines.slice(0, end);
}

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join('/');
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
  const relativePath = relative(resolve(PI_PACKAGE_ROOT), resolve(absolutePath));
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }

  const label = toPosixPath(relativePath);
  if (label === 'README.md' || label.startsWith('docs/') || label.startsWith('examples/')) {
    return { kind: 'docs', label };
  }
  return undefined;
}

function getCompactReadClassification(
  args: ReadToolInput | undefined,
  cwd: string,
): CompactReadClassification | undefined {
  const rawPath = args?.path;
  if (!rawPath) return undefined;

  const absolutePath = resolve(cwd, rawPath);
  const fileName = basename(absolutePath);
  if (fileName === 'SKILL.md') {
    return { kind: 'skill', label: basename(dirname(absolutePath)) || fileName };
  }

  const docsClassification = getPiDocsClassification(absolutePath);
  if (docsClassification) return docsClassification;

  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    return { kind: 'resource', label: absolutePath };
  }

  return undefined;
}

function formatReadResult(
  args: ReadToolInput | undefined,
  result: ReadResultLike,
  options: ToolRenderResultOptions,
  theme: Theme,
  showImages: boolean,
  cwd: string,
  isError: boolean,
): string {
  // Previous behavior: only compact resource/doc/skill reads hide their preview while collapsed.
  if (!options.expanded && !isError && getCompactReadClassification(args, cwd)) {
    return '';
  }

  const rawPath = args?.path;
  const output = getTextOutput(result, showImages);
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split('\n');
  const lines = trimTrailingEmptyLines(renderedLines);
  const maxLines = options.expanded ? lines.length : 10;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  let text = `\n${displayLines
    .map((line) => (lang ? replaceTabs(line) : theme.fg('toolOutput', replaceTabs(line))))
    .join('\n')}`;

  if (remaining > 0) {
    text += `${theme.fg('muted', `\n... (${remaining} more lines,`)} ${keyHint(
      'app.tools.expand',
      'to expand',
    )})`;
  }

  const truncation = result.details?.truncation;
  if (truncation?.truncated) {
    if (truncation.firstLineExceedsLimit) {
      text += `\n${theme.fg(
        'warning',
        `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`,
      )}`;
    } else if (truncation.truncatedBy === 'lines') {
      text += `\n${theme.fg(
        'warning',
        `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`,
      )}`;
    } else {
      text += `\n${theme.fg(
        'warning',
        `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`,
      )}`;
    }
  }

  return text;
}

export default function (pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const read = createReadToolDefinition(cwd);

  pi.registerTool({
    ...read,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tool = createReadToolDefinition(ctx?.cwd ?? cwd);
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderResult(result, options, theme, context) {
      const readContext = context as ReadRenderContextLike;
      const component =
        readContext.lastComponent instanceof Text ? readContext.lastComponent : new Text('', 0, 0);
      component.setText(
        formatReadResult(
          readContext.args,
          result as ReadResultLike,
          options,
          theme,
          readContext.showImages,
          readContext.cwd,
          readContext.isError,
        ),
      );
      return component;
    },
  });
}
