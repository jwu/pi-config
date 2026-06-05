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

type SelectListTruncatePrimary = (
  this: unknown,
  item: AutocompleteItem,
  isSelected: boolean,
  maxWidth: number,
  columnWidth: number,
) => string;

type SelectListRenderItem = (
  this: SelectListInstanceWithTheme,
  item: AutocompleteItem,
  isSelected: boolean,
  width: number,
  descriptionSingleLine: string | undefined,
  primaryColumnWidth: number,
) => string;

type SelectListThemeLike = {
  selectedPrefix?: (text: string) => string;
};

type SelectListInstanceWithTheme = {
  theme?: SelectListThemeLike;
};

type SelectListPrototypeWithPatch = {
  truncatePrimary?: SelectListTruncatePrimary;
  renderItem?: SelectListRenderItem;
  __piConfigFuzzyAtOriginalTruncatePrimary?: SelectListTruncatePrimary;
  __piConfigFuzzyAtOriginalRenderItem?: SelectListRenderItem;
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

function normalizeFinderPath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\\/g, '/');
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const rawPath of paths) {
    const path = normalizeFinderPath(rawPath);
    if (!path || path === '.git' || path.startsWith('.git/')) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
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

class SnacksLikeScorer {
  private consecutive = 0;
  private firstBonus = 0;
  private prev: number | undefined;
  private prevClass = CHAR_WHITE;
  private score = 0;

  constructor(
    private readonly text: string,
    private readonly filenameBonus: boolean,
  ) {}

  init(first: number): void {
    this.consecutive = 0;
    this.firstBonus = 0;
    this.prev = undefined;
    this.prevClass = first > 0 ? charClass(this.text[first - 1]) : CHAR_WHITE;
    this.score = 0;

    if (
      this.filenameBonus &&
      !this.text.includes('/', first + 1) &&
      !this.text.includes('\\', first + 1)
    ) {
      this.score += BONUS_NO_PATH_SEP;
    }

    this.update(first);
  }

  update(pos: number): void {
    const currentClass = charClass(this.text[pos]);
    const gap = this.prev === undefined ? 0 : pos - this.prev - 1;
    let bonus = 0;

    if (gap > 0) {
      this.prevClass = charClass(this.text[pos - 1]);
      bonus = computeBonus(this.prevClass, currentClass);
      this.score += SCORE_GAP_START + (gap - 1) * SCORE_GAP_EXTENSION;
      this.consecutive = 0;
      this.firstBonus = 0;
    } else {
      bonus = computeBonus(this.prevClass, currentClass);
      if (this.consecutive === 0) {
        this.firstBonus = bonus;
      } else {
        if (bonus >= BONUS_BOUNDARY && bonus > this.firstBonus) {
          this.firstBonus = bonus;
        }
        bonus = Math.max(bonus, this.firstBonus, BONUS_CONSECUTIVE);
      }
      this.consecutive += 1;
    }

    if (this.prev === undefined) {
      bonus *= BONUS_FIRST_CHAR_MULTIPLIER;
    }

    this.score += SCORE_MATCH + bonus;
    this.prevClass = currentClass;
    this.prev = pos;
  }

  value(): number {
    return this.score;
  }
}

function fuzzyFindMatch(
  searchText: string,
  displayText: string,
  chars: string[],
  init = 0,
): FuzzyMatch | undefined {
  const first = searchText.indexOf(chars[0] ?? '', init);
  if (first < 0) return undefined;

  const scorer = new SnacksLikeScorer(displayText, true);
  scorer.init(first);

  const positions = [first];
  let last = first;
  for (let index = 1; index < chars.length; index += 1) {
    last = searchText.indexOf(chars[index] ?? '', last + 1);
    if (last < 0) return undefined;
    positions.push(last);
    scorer.update(last);
  }

  return { score: scorer.value(), positions };
}

function fuzzyMatchPath(path: string, query: string): FuzzyMatch | undefined {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return undefined;

  let totalScore = 0;
  const positions: number[] = [];
  const tokens = trimmedQuery.split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    const ignoreCase = isLower(token);
    const searchText = ignoreCase ? path.toLowerCase() : path;
    const normalizedToken = ignoreCase ? token.toLowerCase() : token;
    const chars = Array.from(normalizedToken);

    let bestMatch: FuzzyMatch | undefined;
    let init = 0;

    while (init < searchText.length) {
      const first = searchText.indexOf(chars[0] ?? '', init);
      if (first < 0) break;

      const match = fuzzyFindMatch(searchText, path, chars, first);
      if (match && (!bestMatch || match.score > bestMatch.score)) {
        bestMatch = match;
      }
      init = first + 1;
    }

    if (!bestMatch) return undefined;
    totalScore += bestMatch.score;
    positions.push(...bestMatch.positions);
  }

  return { score: totalScore, positions };
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

function truncateLeftWithMap(
  text: string,
  start: number,
  maxWidth: number,
): { text: string; map: number[] } {
  const markerWidth = visibleWidth(PATH_TRUNCATION_MARKER);
  if (visibleWidth(text) <= maxWidth) {
    return { text, map: Array.from({ length: text.length }, (_value, index) => start + index) };
  }
  if (maxWidth <= markerWidth) {
    return { text: sliceEndToWidth(PATH_TRUNCATION_MARKER, maxWidth), map: [] };
  }

  const tail = sliceEndToWidth(text, maxWidth - markerWidth);
  const tailStart = text.length - tail.length;
  return {
    text: PATH_TRUNCATION_MARKER + tail,
    map: [
      ...Array.from({ length: PATH_TRUNCATION_MARKER.length }, () => -1),
      ...Array.from(tail, (_char, index) => start + tailStart + index),
    ],
  };
}

function mapDisplayPositions(
  positions: number[],
  mappedParts: Array<{ text: string; start?: number; map?: number[] }>,
): number[] {
  const originalToDisplay = new Map<number, number>();
  let displayIndex = 0;

  for (const part of mappedParts) {
    if (part.map) {
      part.map.forEach((originalIndex, index) => {
        if (originalIndex >= 0) originalToDisplay.set(originalIndex, displayIndex + index);
      });
    } else if (part.start !== undefined) {
      for (let index = 0; index < part.text.length; index += 1) {
        originalToDisplay.set(part.start + index, displayIndex + index);
      }
    }
    displayIndex += part.text.length;
  }

  return positions
    .map((position) => originalToDisplay.get(position))
    .filter((position): position is number => position !== undefined);
}

function snacksTruncatePath(path: string, maxWidth: number, positions: number[] = []): DisplayPath {
  const normalizedPath = path.replace(/\\/g, '/').replace(/\/$/, '');
  const marker = `/${PATH_TRUNCATION_MARKER}/`;

  if (maxWidth <= 0) {
    return { text: '', positions: [] };
  }

  if (visibleWidth(normalizedPath) <= maxWidth) {
    return { text: normalizedPath, positions };
  }

  const parts = splitPathParts(normalizedPath);
  if (parts.length < 2) {
    return { text: normalizedPath, positions };
  }

  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const minimumWidth = visibleWidth(first.text) + visibleWidth(marker);

  if (maxWidth <= minimumWidth + 1) {
    const truncated = sliceEndToWidth(
      normalizedPath,
      Math.max(0, maxWidth - visibleWidth(PATH_TRUNCATION_MARKER)),
    );
    const text = PATH_TRUNCATION_MARKER + truncated;
    const start = normalizedPath.length - truncated.length;
    const mappedParts = [
      { text: PATH_TRUNCATION_MARKER, map: [-1] },
      { text: truncated, start },
    ];
    return { text, positions: mapDisplayPositions(positions, mappedParts) };
  }

  const basenameWidth = maxWidth - visibleWidth(first.text) - visibleWidth(marker);
  let tailText = last.text;
  let tailStart = last.start;
  let tailMap: number[] | undefined;

  if (visibleWidth(first.text) + visibleWidth(marker) + visibleWidth(tailText) > maxWidth) {
    const truncatedTail = truncateLeftWithMap(last.text, last.start, basenameWidth);
    tailText = truncatedTail.text;
    tailMap = truncatedTail.map;
  } else {
    let width = visibleWidth(first.text) + visibleWidth(marker) + visibleWidth(tailText);

    for (let index = parts.length - 2; index > 0; index -= 1) {
      const part = parts[index]!;
      const next = `${part.text}/${tailText}`;
      const nextWidth = visibleWidth(first.text) + visibleWidth(marker) + visibleWidth(next);
      if (nextWidth > maxWidth || nextWidth <= width) break;
      tailText = next;
      tailStart = part.start;
      width = nextWidth;
    }
  }

  const text = `${first.text}${marker}${tailText}`;
  const mappedParts = [
    { text: first.text, start: first.start },
    { text: marker, map: Array.from({ length: marker.length }, () => -1) },
    tailMap ? { text: tailText, map: tailMap } : { text: tailText, start: tailStart },
  ];
  return { text, positions: mapDisplayPositions(positions, mappedParts) };
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
  const fdArgs = ['--type', 'f', '--type', 'l', '--color', 'never', '-E', '.git'];

  return [
    { cmd: 'fd', args: fdArgs, normalizePath: normalizeFinderPath },
    { cmd: 'fdfind', args: fdArgs, normalizePath: normalizeFinderPath },
    {
      cmd: 'rg',
      args: ['--files', '--no-messages', '--color', 'never', '-g', '!.git'],
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
