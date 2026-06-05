import { describe, expect, test } from 'bun:test';
import { __testing } from '../extensions/fuzzy-at.ts';

const {
  buildFinderCommands,
  extractAtToken,
  filterFuzzyPaths,
  fuzzyScorePath,
  highlightPositions,
  normalizeFinderPath,
  quoteCompletionPath,
  uniquePaths,
} = __testing;

describe('fuzzy @ autocomplete helpers', () => {
  test('extracts plain and quoted @ tokens at token boundaries', () => {
    expect(extractAtToken('see @myfbar')).toEqual({ prefix: '@myfbar', query: 'myfbar', quoted: false });
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

  test('highlights matched positions with warning-colored spans', () => {
    expect(highlightPositions('foobar.md', [0, 3, 4], 0, (text) => `<warning>${text}</warning>`)).toBe(
      '<warning>f</warning>oo<warning>ba</warning>r.md',
    );
    expect(highlightPositions('foobar.md', [3, 4], 3, (text) => `<warning>${text}</warning>`)).toBe(
      '<warning>fo</warning>obar.md',
    );
    expect(highlightPositions('foobar.md', [0])).toBe('\x1b[33mf\x1b[39moobar.md');
  });

  test('normalizes and deduplicates finder paths', () => {
    expect(normalizeFinderPath('./my/path/foobar.md')).toBe('my/path/foobar.md');
    expect(uniquePaths(['./a.ts', 'a.ts', '.git/config', ''])).toEqual(['a.ts']);
  });

  test('quotes completion values when needed', () => {
    expect(quoteCompletionPath('my/path/foobar.md', false)).toBe('@my/path/foobar.md');
    expect(quoteCompletionPath('my path/foobar.md', false)).toBe('@"my path/foobar.md"');
    expect(quoteCompletionPath('my/path/foobar.md', true)).toBe('@"my/path/foobar.md"');
  });

  test('uses snacks finder command fallback order', () => {
    expect(buildFinderCommands().map((command) => command.cmd)).toEqual(['fd', 'fdfind', 'rg', 'find']);
  });
});
