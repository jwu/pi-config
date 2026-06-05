import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { SelectList, visibleWidth } from '@earendil-works/pi-tui';
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from '@earendil-works/pi-tui';

const MAX_SUGGESTIONS = 20;
const CACHE_TTL_MS = 15_000;
const FINDER_TIMEOUT_MS = 3_000;
const PATH_TRUNCATION_MARKER = '…';
const FUZZY_AT_PATH_META = '__piConfigFuzzyAtPathMeta';

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = SCORE_MATCH / 2;
const BONUS_NONWORD = SCORE_MATCH / 2;
const BONUS_CAMEL_123 = BONUS_BOUNDARY - 1;
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
const BONUS_NO_PATH_SEP = BONUS_BOUNDARY - 2;

const CHAR_WHITE = 0;
const CHAR_NONWORD = 1;
const CHAR_DELIMITER = 2;
const CHAR_LOWER = 3;
const CHAR_UPPER = 4;
const CHAR_NUMBER = 6;

interface AtToken {
  prefix: string;
  query: string;
  quoted: boolean;
}

interface FinderCommand {
  cmd: string;
  args: string[];
  normalizePath(path: string): string;
}

interface CacheEntry {
  expiresAt: number;
  promise: Promise<string[]>;
}

type HighlightStyle = (text: string) => string;

interface FuzzyMatch {
  score: number;
  positions: number[];
}

interface ScoredPath {
  path: string;
  score: number;
  positions: number[];
  index: number;
}

interface DisplayPath {
  text: string;
  positions: number[];
}

interface FuzzyAtPathMeta {
  path: string;
  positions: number[];
  highlightStyle: HighlightStyle;
}

interface FuzzyAtAutocompleteItem extends AutocompleteItem {
  [FUZZY_AT_PATH_META]: FuzzyAtPathMeta;
}

interface PathPart {
  text: string;
  start: number;
}

interface DisplaySegment {
  text: string;
  start?: number;
}

type TruncatePrimary = (
  item: AutocompleteItem,
  isSelected: boolean,
  maxWidth: number,
  columnWidth: number,
) => string;

type RenderItem = (
  item: AutocompleteItem,
  isSelected: boolean,
  width: number,
  descriptionSingleLine: string | undefined,
  primaryColumnWidth: number,
) => string;

type SelectListThemeLike = { selectedPrefix?: HighlightStyle };
type SelectListInstanceWithTheme = { theme?: SelectListThemeLike };

type SelectListPrototypeWithPatch = {
  truncatePrimary?: TruncatePrimary;
  renderItem?: RenderItem;
  __piConfigFuzzyAtOriginalTruncatePrimary?: TruncatePrimary;
  __piConfigFuzzyAtOriginalRenderItem?: RenderItem;
};

function extractAtToken(textBeforeCursor: string): AtToken | undefined {
  const quoted = /(?:^|[ \t])(@"[^"]*)$/.exec(textBeforeCursor);
  if (quoted?.[1]) {
    return {
      prefix: quoted[1],
      query: quoted[1].slice(2),
      quoted: true,
    };
  }

  const plain = /(?:^|[ \t])(@[^\s"]*)$/.exec(textBeforeCursor);
  if (!plain?.[1]) return undefined;

  return {
    prefix: plain[1],
    query: plain[1].slice(1),
    quoted: false,
  };
}

function shouldCloseAtAutocomplete(textBeforeCursor: string): boolean {
  return /(?:^|[ \t])@[^\s"]*[ \t]$/.test(textBeforeCursor);
}

function normalizeFinderPath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\\/g, '/');
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parentDirectoryCandidates(path: string): string[] {
  const trimmed = path.replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  const directories: string[] = [];

  for (let index = 1; index < parts.length; index += 1) {
    directories.push(`${parts.slice(0, index).join('/')}/`);
  }

  return directories;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  const addPath = (path: string) => {
    if (!path || path === '.git' || path.startsWith('.git/')) return;
    if (seen.has(path)) return;
    seen.add(path);
    unique.push(path);
  };

  for (const rawPath of paths) {
    const path = normalizeFinderPath(rawPath);
    if (!path || path === '.git' || path.startsWith('.git/')) continue;

    for (const directory of parentDirectoryCandidates(path)) {
      addPath(directory);
    }
    addPath(path);
  }

  return unique.sort(comparePath);
}

function isLower(value: string): boolean {
  return value.toLowerCase() === value;
}

function charClass(char: string | undefined): number {
  if (!char) return CHAR_NONWORD;
  const code = char.charCodeAt(0);

  if (/\s/.test(char)) return CHAR_WHITE;
  if (/[\\/,:;|]/.test(char)) return CHAR_DELIMITER;
  if (code >= 48 && code <= 57) return CHAR_NUMBER;
  if (code >= 65 && code <= 90) return CHAR_UPPER;
  if (code >= 97 && code <= 122) return CHAR_LOWER;
  return CHAR_NONWORD;
}

function computeBonus(prev: number, curr: number): number {
  if (curr > CHAR_NONWORD) {
    if (prev === CHAR_WHITE) return BONUS_BOUNDARY + 2;
    if (prev === CHAR_DELIMITER) return BONUS_BOUNDARY + 1;
    if (prev === CHAR_NONWORD) return BONUS_BOUNDARY;
  }

  if (
    (prev === CHAR_LOWER && curr === CHAR_UPPER) ||
    (prev !== CHAR_NUMBER && curr === CHAR_NUMBER)
  ) {
    return BONUS_CAMEL_123;
  }

  if (curr === CHAR_NONWORD || curr === CHAR_DELIMITER) return BONUS_NONWORD;
  if (curr === CHAR_WHITE) return BONUS_BOUNDARY + 2;
  return 0;
}

function scorePositions(text: string, positions: number[]): number {
  const first = positions[0];
  let consecutive = 0;
  let firstBonus = 0;
  let prev: number | undefined;
  let prevClass = first !== undefined && first > 0 ? charClass(text[first - 1]) : CHAR_WHITE;
  let score = 0;

  if (first !== undefined && !text.includes('/', first + 1) && !text.includes('\\', first + 1)) {
    score += BONUS_NO_PATH_SEP;
  }

  for (const pos of positions) {
    const currentClass = charClass(text[pos]);
    const gap = prev === undefined ? 0 : pos - prev - 1;
    let bonus = computeBonus(gap > 0 ? charClass(text[pos - 1]) : prevClass, currentClass);

    if (gap > 0) {
      score += SCORE_GAP_START + (gap - 1) * SCORE_GAP_EXTENSION;
      consecutive = 0;
      firstBonus = 0;
    } else if (consecutive === 0) {
      firstBonus = bonus;
      consecutive += 1;
    } else {
      if (bonus >= BONUS_BOUNDARY && bonus > firstBonus) firstBonus = bonus;
      bonus = Math.max(bonus, firstBonus, BONUS_CONSECUTIVE);
      consecutive += 1;
    }

    score += SCORE_MATCH + (prev === undefined ? bonus * BONUS_FIRST_CHAR_MULTIPLIER : bonus);
    prevClass = currentClass;
    prev = pos;
  }

  return score;
}

function findTokenPositions(
  searchText: string,
  chars: string[],
  first: number,
): number[] | undefined {
  const positions = [first];
  let last = first;

  for (const char of chars.slice(1)) {
    last = searchText.indexOf(char, last + 1);
    if (last < 0) return undefined;
    positions.push(last);
  }

  return positions;
}

function fuzzyMatchToken(path: string, token: string): FuzzyMatch | undefined {
  const ignoreCase = isLower(token);
  const searchText = ignoreCase ? path.toLowerCase() : path;
  const chars = Array.from(ignoreCase ? token.toLowerCase() : token);
  let bestMatch: FuzzyMatch | undefined;

  for (
    let first = searchText.indexOf(chars[0] ?? '');
    first >= 0;
    first = searchText.indexOf(chars[0] ?? '', first + 1)
  ) {
    const positions = findTokenPositions(searchText, chars, first);
    if (!positions) continue;

    const match = { score: scorePositions(path, positions), positions };
    if (!bestMatch || match.score > bestMatch.score) bestMatch = match;
  }

  return bestMatch;
}

function fuzzyMatchPath(path: string, query: string): FuzzyMatch | undefined {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;

  let score = 0;
  const positions: number[] = [];

  for (const token of tokens) {
    const match = fuzzyMatchToken(path, token);
    if (!match) return undefined;
    score += match.score;
    positions.push(...match.positions);
  }

  return { score, positions };
}

function fuzzyScorePath(path: string, query: string): number | undefined {
  return fuzzyMatchPath(path, query)?.score;
}

function filterFuzzyPaths(paths: string[], query: string, limit = MAX_SUGGESTIONS): ScoredPath[] {
  const scored: ScoredPath[] = [];

  paths.forEach((path, index) => {
    const match = fuzzyMatchPath(path, query);
    if (match) {
      scored.push({ path, score: match.score, positions: match.positions, index });
    }
  });

  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.index - b.index);
  return scored.slice(0, limit);
}

function quoteCompletionPath(path: string, quoted: boolean): string {
  if (quoted || /\s/.test(path)) {
    return `@"${path.replace(/"/g, '\\"')}"`;
  }
  return `@${path}`;
}

function warningAnsi(text: string): string {
  return `\x1b[33m${text}\x1b[39m`;
}

function highlightPositions(
  text: string,
  positions: number[],
  offset = 0,
  style: HighlightStyle = warningAnsi,
): string {
  const matched = new Set(positions.map((position) => position - offset));
  let highlighted = '';
  let segment = '';
  let active = false;

  const flushSegment = () => {
    if (!segment) return;
    highlighted += active ? style(segment) : segment;
    segment = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const shouldHighlight = matched.has(index);
    if (shouldHighlight !== active) {
      flushSegment();
      active = shouldHighlight;
    }
    segment += text[index];
  }

  flushSegment();
  return highlighted;
}

function splitPathParts(path: string): PathPart[] {
  const parts: PathPart[] = [];
  let start = 0;

  for (const text of path.split('/')) {
    parts.push({ text, start });
    start += text.length + 1;
  }

  return parts;
}

function sliceEndToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(text) <= maxWidth) return text;

  let sliced = '';
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const next = text[index] + sliced;
    if (visibleWidth(next) > maxWidth) break;
    sliced = next;
  }
  return sliced;
}

function truncateLeftSegments(text: string, start: number, maxWidth: number): DisplaySegment[] {
  const markerWidth = visibleWidth(PATH_TRUNCATION_MARKER);
  if (visibleWidth(text) <= maxWidth) return [{ text, start }];
  if (maxWidth <= markerWidth) return [{ text: sliceEndToWidth(PATH_TRUNCATION_MARKER, maxWidth) }];

  const tail = sliceEndToWidth(text, maxWidth - markerWidth);
  return [
    { text: PATH_TRUNCATION_MARKER },
    { text: tail, start: start + text.length - tail.length },
  ];
}

function buildDisplayPath(positions: number[], segments: DisplaySegment[]): DisplayPath {
  const text = segments.map((segment) => segment.text).join('');
  const mappedPositions = positions
    .map((position) => {
      let displayIndex = 0;

      for (const segment of segments) {
        const segmentStart = segment.start;
        if (
          segmentStart !== undefined &&
          position >= segmentStart &&
          position < segmentStart + segment.text.length
        ) {
          return displayIndex + position - segmentStart;
        }
        displayIndex += segment.text.length;
      }

      return undefined;
    })
    .filter((position): position is number => position !== undefined);

  return { text, positions: mappedPositions };
}

function snacksTruncatePath(path: string, maxWidth: number, positions: number[] = []): DisplayPath {
  const slashNormalizedPath = path.replace(/\\/g, '/');
  const hasTrailingSlash = slashNormalizedPath.length > 1 && slashNormalizedPath.endsWith('/');
  const normalizedPath = hasTrailingSlash
    ? slashNormalizedPath.replace(/\/+$/, '')
    : slashNormalizedPath;
  const marker = `/${PATH_TRUNCATION_MARKER}/`;

  const finish = (display: DisplayPath): DisplayPath => {
    if (!hasTrailingSlash) return display;

    const slashIndex = normalizedPath.length;
    const slashPositions = positions.includes(slashIndex) ? [display.text.length] : [];
    return { text: `${display.text}/`, positions: [...display.positions, ...slashPositions] };
  };

  if (maxWidth <= 0) {
    return { text: '', positions: [] };
  }

  const fullPath = hasTrailingSlash ? `${normalizedPath}/` : normalizedPath;
  if (visibleWidth(fullPath) <= maxWidth) {
    return { text: fullPath, positions };
  }

  const contentMaxWidth = hasTrailingSlash ? Math.max(0, maxWidth - 1) : maxWidth;
  const parts = splitPathParts(normalizedPath);
  if (parts.length < 2) {
    return finish({ text: normalizedPath, positions });
  }

  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const minimumWidth = visibleWidth(first.text) + visibleWidth(marker);

  if (contentMaxWidth <= minimumWidth + 1) {
    const truncated = sliceEndToWidth(
      normalizedPath,
      Math.max(0, contentMaxWidth - visibleWidth(PATH_TRUNCATION_MARKER)),
    );
    return finish(
      buildDisplayPath(positions, [
        { text: PATH_TRUNCATION_MARKER },
        { text: truncated, start: normalizedPath.length - truncated.length },
      ]),
    );
  }

  const basenameWidth = contentMaxWidth - visibleWidth(first.text) - visibleWidth(marker);
  let tailText = last.text;
  let tailSegments: DisplaySegment[] = [{ text: last.text, start: last.start }];

  if (visibleWidth(first.text) + visibleWidth(marker) + visibleWidth(tailText) > contentMaxWidth) {
    tailSegments = truncateLeftSegments(last.text, last.start, basenameWidth);
  } else {
    let width = visibleWidth(first.text) + visibleWidth(marker) + visibleWidth(tailText);

    for (let index = parts.length - 2; index > 0; index -= 1) {
      const part = parts[index]!;
      const next = `${part.text}/${tailText}`;
      const nextWidth = visibleWidth(first.text) + visibleWidth(marker) + visibleWidth(next);
      if (nextWidth > contentMaxWidth || nextWidth <= width) break;
      tailText = next;
      tailSegments = [{ text: tailText, start: part.start }];
      width = nextWidth;
    }
  }

  return finish(
    buildDisplayPath(positions, [
      { text: first.text, start: first.start },
      { text: marker },
      ...tailSegments,
    ]),
  );
}

function getFuzzyAtMeta(item: AutocompleteItem): FuzzyAtPathMeta | undefined {
  return (item as Partial<FuzzyAtAutocompleteItem>)[FUZZY_AT_PATH_META];
}

function renderFuzzyAtItem(
  item: AutocompleteItem,
  isSelected: boolean,
  width: number,
  theme: SelectListThemeLike | undefined,
): string | undefined {
  const meta = getFuzzyAtMeta(item);
  if (!meta) return undefined;

  const rawPrefix = isSelected ? '→ ' : '  ';
  const prefix = isSelected && theme?.selectedPrefix ? theme.selectedPrefix(rawPrefix) : rawPrefix;
  const maxWidth = Math.max(1, width - visibleWidth(rawPrefix) - 2);
  const display = snacksTruncatePath(meta.path, maxWidth, meta.positions);
  const path = highlightPositions(display.text, display.positions, 0, meta.highlightStyle);

  return prefix + path;
}

function installSnacksPathTruncationPatch(): void {
  const prototype = SelectList.prototype as unknown as SelectListPrototypeWithPatch;
  if (!prototype.truncatePrimary || !prototype.renderItem) return;

  const originalTruncatePrimary =
    prototype.__piConfigFuzzyAtOriginalTruncatePrimary ?? prototype.truncatePrimary;
  prototype.__piConfigFuzzyAtOriginalTruncatePrimary = originalTruncatePrimary;
  prototype.truncatePrimary = function truncatePrimaryWithSnacksPath(
    this: unknown,
    item: AutocompleteItem,
    isSelected: boolean,
    maxWidth: number,
    columnWidth: number,
  ): string {
    const meta = getFuzzyAtMeta(item);
    if (meta) {
      const display = snacksTruncatePath(meta.path, maxWidth, meta.positions);
      return highlightPositions(display.text, display.positions, 0, meta.highlightStyle);
    }

    return originalTruncatePrimary.call(this, item, isSelected, maxWidth, columnWidth);
  };

  const originalRenderItem = prototype.__piConfigFuzzyAtOriginalRenderItem ?? prototype.renderItem;
  prototype.__piConfigFuzzyAtOriginalRenderItem = originalRenderItem;
  prototype.renderItem = function renderItemWithFuzzyAtPath(
    this: SelectListInstanceWithTheme,
    item: AutocompleteItem,
    isSelected: boolean,
    width: number,
    descriptionSingleLine: string | undefined,
    primaryColumnWidth: number,
  ): string {
    const rendered = renderFuzzyAtItem(item, isSelected, width, this.theme);
    if (rendered !== undefined) return rendered;

    return originalRenderItem.call(
      this,
      item,
      isSelected,
      width,
      descriptionSingleLine,
      primaryColumnWidth,
    );
  };
}

function toAutocompleteItem(
  match: ScoredPath,
  quoted: boolean,
  highlightStyle: HighlightStyle,
): AutocompleteItem {
  const item: FuzzyAtAutocompleteItem = {
    value: quoteCompletionPath(match.path, quoted),
    label: highlightPositions(match.path, match.positions, 0, highlightStyle),
    [FUZZY_AT_PATH_META]: {
      path: match.path,
      positions: match.positions,
      highlightStyle,
    },
  };

  return item;
}

function stripCompletionPrefix(value: string): string {
  let path = value.startsWith('@') ? value.slice(1) : value;
  if (path.startsWith('"')) {
    path = path.slice(1);
    if (path.endsWith('"')) path = path.slice(0, -1);
    path = path.replace(/\\"/g, '"');
  }
  return path;
}

function displayPathFromAutocompleteItem(item: AutocompleteItem): string {
  const valuePath = stripCompletionPrefix(item.value);
  let path = item.description?.trim() || valuePath || item.label;
  const isDirectory = item.label.endsWith('/') || valuePath.endsWith('/');

  if (isDirectory && path && !path.endsWith('/')) {
    path += '/';
  }

  return path;
}

function toSinglePathAtSuggestions(
  suggestions: AutocompleteSuggestions,
  highlightStyle: HighlightStyle,
): AutocompleteSuggestions {
  return {
    prefix: suggestions.prefix,
    items: suggestions.items.map((item) => {
      const path = displayPathFromAutocompleteItem(item);
      const transformed: FuzzyAtAutocompleteItem = {
        ...item,
        label: path,
        description: undefined,
        [FUZZY_AT_PATH_META]: {
          path,
          positions: [],
          highlightStyle,
        },
      };
      return transformed;
    }),
  };
}

function buildFinderCommands(): FinderCommand[] {
  const fdArgs = ['--type', 'f', '--type', 'l', '--hidden', '--color', 'never', '-E', '.git'];

  return [
    { cmd: 'fd', args: fdArgs, normalizePath: normalizeFinderPath },
    { cmd: 'fdfind', args: fdArgs, normalizePath: normalizeFinderPath },
    {
      cmd: 'rg',
      args: ['--files', '--hidden', '--no-messages', '--color', 'never', '-g', '!.git'],
      normalizePath: normalizeFinderPath,
    },
    {
      cmd: 'find',
      args: ['.', '-type', 'f', '-not', '-path', '*/.git/*'],
      normalizePath: normalizeFinderPath,
    },
  ];
}

async function enumerateCandidatePaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  for (const finder of buildFinderCommands()) {
    const result = await pi.exec(finder.cmd, finder.args, { cwd, timeout: FINDER_TIMEOUT_MS });
    const lines = result.stdout.split('\n').map(finder.normalizePath);

    if (result.code === 0) {
      return uniquePaths(lines);
    }
  }

  return [];
}

function createPathCache(pi: ExtensionAPI): (cwd: string) => Promise<string[]> {
  const cache = new Map<string, CacheEntry>();

  return (cwd: string) => {
    const now = Date.now();
    const cached = cache.get(cwd);
    if (cached && cached.expiresAt > now) {
      return cached.promise;
    }

    const promise = enumerateCandidatePaths(pi, cwd).catch(() => []);
    cache.set(cwd, { expiresAt: now + CACHE_TTL_MS, promise });
    return promise;
  };
}

function createFuzzyAtProvider(
  current: AutocompleteProvider,
  getPaths: (cwd: string) => Promise<string[]>,
  cwd: string,
  highlightStyle: HighlightStyle,
): AutocompleteProvider {
  return {
    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? '';
      const beforeCursor = line.slice(0, cursorCol);
      const token = extractAtToken(beforeCursor);

      if (!token) {
        if (shouldCloseAtAutocomplete(beforeCursor)) return null;
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const getCurrentAtSuggestions = async () => {
        const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        return suggestions ? toSinglePathAtSuggestions(suggestions, highlightStyle) : null;
      };

      if (token.query.length === 0) {
        const suggestions = await getCurrentAtSuggestions();
        if (suggestions || options.signal.aborted) return suggestions;

        const paths = await getPaths(cwd);
        if (options.signal.aborted || paths.length === 0) return null;

        return {
          prefix: token.prefix,
          items: paths
            .slice(0, MAX_SUGGESTIONS)
            .map((path, index) =>
              toAutocompleteItem(
                { path, score: 0, positions: [], index },
                token.quoted,
                highlightStyle,
              ),
            ),
        };
      }

      const paths = await getPaths(cwd);
      if (options.signal.aborted) return null;
      if (paths.length === 0) {
        return getCurrentAtSuggestions();
      }

      const matches = filterFuzzyPaths(paths, token.query);
      if (matches.length === 0) {
        return getCurrentAtSuggestions();
      }

      return {
        prefix: token.prefix,
        items: matches.map((match) => toAutocompleteItem(match, token.quoted, highlightStyle)),
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export const __testing = {
  buildFinderCommands,
  comparePath,
  computeBonus,
  extractAtToken,
  filterFuzzyPaths,
  fuzzyScorePath,
  highlightPositions,
  normalizeFinderPath,
  quoteCompletionPath,
  renderFuzzyAtItem,
  shouldCloseAtAutocomplete,
  snacksTruncatePath,
  toAutocompleteItem,
  toSinglePathAtSuggestions,
  uniquePaths,
};

export default function (pi: ExtensionAPI): void {
  installSnacksPathTruncationPatch();
  const getPaths = createPathCache(pi);

  pi.on('session_start', (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) =>
      createFuzzyAtProvider(current, getPaths, ctx.cwd, (text) => ctx.ui.theme.fg('warning', text)),
    );
  });
}
