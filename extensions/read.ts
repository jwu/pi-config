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
  keyText,
  type ExtensionAPI,
  type ReadToolDetails,
  type ReadToolInput,
  type Theme,
  type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { getCapabilities, getImageDimensions, imageFallback, Text } from '@earendil-works/pi-tui';

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

type ReadArgsLike = Partial<ReadToolInput> & {
  file_path?: unknown;
  path?: unknown;
};

interface ReadRenderCallContextLike {
  cwd: string;
  expanded: boolean;
  lastComponent: unknown;
}

interface ReadRenderContextLike {
  args: ReadArgsLike;
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
  const textBlocks = result.content.filter(
    (content): content is TextContentLike => content.type === 'text',
  );
  const imageBlocks = result.content.filter(
    (content): content is ImageContentLike => content.type === 'image',
  );

  let output = textBlocks.map((content) => sanitizeDisplayText(content.text || '')).join('\n');
  const caps = getCapabilities();

  if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
    const imageIndicators = imageBlocks
      .map((image) => {
        const mimeType = image.mimeType ?? 'image/unknown';
        const dimensions =
          image.data && image.mimeType
            ? (getImageDimensions(image.data, image.mimeType) ?? undefined)
            : undefined;
        return imageFallback(mimeType, dimensions);
      })
      .join('\n');

    output = output ? `${output}\n${imageIndicators}` : imageIndicators;
  }

  return output;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') {
    end--;
  }
  return lines.slice(0, end);
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return null;
}

function getReadArgPath(args: ReadArgsLike | undefined): string | null {
  return str(args?.file_path ?? args?.path);
}

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join('/');
}

function formatPathRelativeToCwdOrAbsolute(absolutePath: string, cwd: string): string {
  const relativePath = relative(resolve(cwd), resolve(absolutePath));
  if (
    relativePath &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  ) {
    return toPosixPath(relativePath);
  }
  return absolutePath;
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
  args: ReadArgsLike | undefined,
  cwd: string,
): CompactReadClassification | undefined {
  const rawPath = getReadArgPath(args);
  if (!rawPath) return undefined;

  const absolutePath = resolve(cwd, rawPath);
  const fileName = basename(absolutePath);
  if (fileName === 'SKILL.md') {
    return { kind: 'skill', label: formatPathRelativeToCwdOrAbsolute(dirname(absolutePath), cwd) };
  }

  const docsClassification = getPiDocsClassification(absolutePath);
  if (docsClassification) return docsClassification;

  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    return { kind: 'resource', label: absolutePath };
  }

  return undefined;
}

function formatReadLineRange(args: ReadArgsLike | undefined, theme: Theme): string {
  if (args?.offset === undefined && args?.limit === undefined) return '';
  const startLine = args.offset ?? 1;
  const endLine = args.limit !== undefined ? startLine + args.limit - 1 : '';
  return theme.fg('warning', `:${startLine}${endLine ? `-${endLine}` : ''}`);
}

function formatSkillReadCall(
  classification: CompactReadClassification,
  args: ReadArgsLike | undefined,
  theme: Theme,
): string {
  const expandHint = theme.fg('dim', ` (${keyText('app.tools.expand')} to expand)`);
  return `${theme.fg('toolTitle', theme.bold('read skill'))} ${theme.fg('accent', classification.label)}${formatReadLineRange(args, theme)}${expandHint}`;
}

function formatReadResult(
  args: ReadArgsLike | undefined,
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

  const rawPath = getReadArgPath(args);
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

    renderCall(args, theme, context) {
      const readContext = context as ReadRenderCallContextLike;
      const classification = !readContext.expanded
        ? getCompactReadClassification(args as ReadArgsLike, readContext.cwd)
        : undefined;
      if (classification?.kind !== 'skill') {
        return read.renderCall?.(args, theme, context) ?? new Text('', 0, 0);
      }

      const component =
        readContext.lastComponent instanceof Text ? readContext.lastComponent : new Text('', 0, 0);
      component.setText(formatSkillReadCall(classification, args as ReadArgsLike, theme));
      return component;
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
