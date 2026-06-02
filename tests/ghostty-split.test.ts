import { describe, expect, test } from 'bun:test';
import { __testing } from '../extensions/ghostty-split.ts';

const { appleScriptEscape, buildGhosttySplitScript, isGhosttyOnMac } = __testing;

describe('ghostty-split helpers', () => {
  test('escapes AppleScript string literals', () => {
    expect(appleScriptEscape('/tmp/has "quotes" and \\slashes')).toBe(
      '/tmp/has \\"quotes\\" and \\\\slashes',
    );
  });

  test('builds split script with escaped cwd, session file, and direction', () => {
    const script = buildGhosttySplitScript('right', '/tmp/session "one".json', '/tmp/work\\dir');

    expect(script).toContain('tell application "Ghostty"');
    expect(script).toContain('set initial working directory of cfg to "/tmp/work\\\\dir"');
    expect(script).toContain('pi --session \\"/tmp/session \\"one\\".json\\"');
    expect(script).toContain('direction right with configuration cfg');
  });

  test('detects Ghostty on macOS only', () => {
    if (process.platform !== 'darwin') {
      process.env.TERM_PROGRAM = 'ghostty';
      expect(isGhosttyOnMac()).toBe(false);
    }
  });
});
