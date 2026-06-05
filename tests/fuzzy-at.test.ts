import { describe, expect, test } from 'bun:test';
import { __testing } from '../extensions/fuzzy-at.ts';

const {
  buildFinderCommands,
  comparePath,
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
} = __testing;

describe('fuzzy @ autocomplete helpers', () => {
  test('extracts plain and quoted @ tokens at token boundaries', () => {
    expect(extractAtToken('see @myfbar')).toEqual({
      prefix: '@myfbar',
      query: 'myfbar',
      quoted: false,
    });
    expect(extractAtToken('see @"my path')).toEqual({
      prefix: '@"my path',
      query: 'my path',
      quoted: true,
    });
    expect(extractAtToken('email foo@bar')).toBeUndefined();
  });

  test('matches snacks-style subsequences across full paths', () => {
    expect(fuzzyScorePath('my/path/foobar.md', 'mpafbar')).toBeGreaterThan(0);
    expect(fuzzyScorePath('my/path/foobar.md', 'myfbar')).toBeGreaterThan(0);
    expect(fuzzyScorePath('my/path/foobar.md', 'zzzz')).toBeUndefined();
  });

  test('filters and ranks fuzzy path candidates with match positions', () => {
    const paths = ['docs/readme.md', 'my/path/foobar.md', 'src/foo.ts'];
    const matches = filterFuzzyPaths(paths, 'myfbar');
    expect(matches.map((match) => match.path)).toEqual(['my/path/foobar.md']);
    expect(matches[0]?.positions.length).toBe('myfbar'.length);
  });

  test('matches directory slash queries against directory and descendant file candidates', () => {
    const paths = uniquePaths(['path/to/foobar/a.txt']);
    const matches = filterFuzzyPaths(paths, 'foobar/');
    expect(matches.map((match) => match.path)).toEqual([
      'path/to/foobar/',
      'path/to/foobar/a.txt',
    ]);
  });

  test('sorts fuzzy paths with snacks default fields: score desc, text length asc, stable idx', () => {
    const paths = ['a/long/b.ts', 'a/b.ts'];
    const matches = filterFuzzyPaths(paths, 'a');
    expect(matches.map((match) => match.path)).toEqual(['a/b.ts', 'a/long/b.ts']);
  });

  test('highlights matched positions with warning-colored spans', () => {
    expect(
      highlightPositions('foobar.md', [0, 3, 4], 0, (text) => `<warning>${text}</warning>`),
    ).toBe('<warning>f</warning>oo<warning>ba</warning>r.md');
    expect(highlightPositions('foobar.md', [3, 4], 3, (text) => `<warning>${text}</warning>`)).toBe(
      '<warning>fo</warning>obar.md',
    );
    expect(highlightPositions('foobar.md', [0])).toBe('\x1b[33mf\x1b[39moobar.md');
  });

  test('formats autocomplete candidates as full paths instead of basename plus description', () => {
    const item = toAutocompleteItem(
      { path: 'my/path/foobar.md', score: 1, positions: [0, 3, 8], index: 0 },
      false,
      (text) => `<warning>${text}</warning>`,
    );

    expect(item.value).toBe('@my/path/foobar.md');
    expect(item.label).toBe(
      '<warning>m</warning>y/<warning>p</warning>ath/<warning>f</warning>oobar.md',
    );
    expect(item.description).toBeUndefined();
  });

  test('truncates long paths with snacks-style center path folding', () => {
    expect(snacksTruncatePath('a/b/c/d/e.md', 10, [0, 8, 10, 11])).toEqual({
      text: 'a/…/d/e.md',
      positions: [0, 6, 8, 9],
    });
    expect(snacksTruncatePath('a/b/superlongfilename.md', 12).text).toBe('a/…/…name.md');
    expect(snacksTruncatePath('path/to/foobar/', 80, [8, 14])).toEqual({
      text: 'path/to/foobar/',
      positions: [8, 14],
    });
  });

  test('converts delegated empty @ suggestions to single-column full paths', () => {
    const suggestions = toSinglePathAtSuggestions(
      {
        prefix: '@',
        items: [
          { value: '@.clang-format', label: '.clang-format', description: '.clang-format' },
          { value: '@.github/', label: '.github/', description: '.github' },
          {
            value: '@.github/ISSUE_TEMPLATE/bug_report.yml',
            label: 'bug_report.yml',
            description: '.github/ISSUE_TEMPLATE/bug_report.yml',
          },
        ],
      },
      (text) => `<warning>${text}</warning>`,
    );

    expect(
      suggestions.items.map((item) => ({ label: item.label, description: item.description })),
    ).toEqual([
      { label: '.clang-format', description: undefined },
      { label: '.github/', description: undefined },
      { label: '.github/ISSUE_TEMPLATE/bug_report.yml', description: undefined },
    ]);
  });

  test('does not wrap selected fuzzy @ rows with selected text color over match highlights', () => {
    const item = toAutocompleteItem(
      { path: 'editor/editor_node.h', score: 1, positions: [0, 7], index: 0 },
      false,
      (text) => `<warning>${text}</warning>`,
    );

    expect(
      renderFuzzyAtItem(item, true, 80, {
        selectedPrefix: (text) => `<selected-prefix>${text}</selected-prefix>`,
      }),
    ).toBe(
      '<selected-prefix>→ </selected-prefix><warning>e</warning>ditor/<warning>e</warning>ditor_node.h',
    );
  });

  test('normalizes, deduplicates, stabilizes, and adds parent directory candidates', () => {
    expect(normalizeFinderPath('./my/path/foobar.md')).toBe('my/path/foobar.md');
    expect(uniquePaths(['b.ts', './a.ts', 'a.ts', '.git/config', ''])).toEqual(['a.ts', 'b.ts']);
    expect(uniquePaths(['./path/to/foobar/a.txt'])).toEqual([
      'path/',
      'path/to/',
      'path/to/foobar/',
      'path/to/foobar/a.txt',
    ]);
    expect(['b.ts', 'a.ts'].sort(comparePath)).toEqual(['a.ts', 'b.ts']);
  });

  test('quotes completion values when needed', () => {
    expect(quoteCompletionPath('my/path/foobar.md', false)).toBe('@my/path/foobar.md');
    expect(quoteCompletionPath('my path/foobar.md', false)).toBe('@"my path/foobar.md"');
    expect(quoteCompletionPath('my/path/foobar.md', true)).toBe('@"my/path/foobar.md"');
  });

  test('uses snacks finder command fallback order', () => {
    expect(buildFinderCommands().map((command) => command.cmd)).toEqual([
      'fd',
      'fdfind',
      'rg',
      'find',
    ]);
  });
});
