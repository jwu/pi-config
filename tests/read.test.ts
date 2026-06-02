import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { __testing } from '../extensions/read.ts';

const {
  formatPathRelativeToCwdOrAbsolute,
  formatReadLineRange,
  formatReadResult,
  getCompactReadClassification,
  getReadArgPath,
  getTextOutput,
  trimTrailingEmptyLines,
} = __testing;

const theme = {
  fg: (_color: string, value: string) => value,
};

describe('read extension helpers', () => {
  test('normalizes read path args', () => {
    expect(getReadArgPath({ file_path: 'a.ts' })).toBe('a.ts');
    expect(getReadArgPath({ path: 'b.ts' })).toBe('b.ts');
    expect(getReadArgPath({ path: null })).toBe('');
    expect(getReadArgPath({ path: 123 })).toBeNull();
  });

  test('formats paths relative to cwd when possible', () => {
    const cwd = path.resolve('/tmp/project');
    expect(formatPathRelativeToCwdOrAbsolute(path.join(cwd, 'src/file.ts'), cwd)).toBe(
      'src/file.ts',
    );
    expect(formatPathRelativeToCwdOrAbsolute('/other/file.ts', cwd)).toBe('/other/file.ts');
  });

  test('classifies skill reads for compact rendering', () => {
    expect(
      getCompactReadClassification({ path: '.pi/skills/ask-user/SKILL.md' }, '/repo'),
    ).toEqual({ kind: 'skill', label: '.pi/skills/ask-user' });
  });

  test('sanitizes text blocks and trims trailing empty lines', () => {
    expect(getTextOutput({ content: [{ type: 'text', text: 'hello\u001b[31m\u001b[0m' }] }, true)).toBe(
      'hello',
    );
    expect(trimTrailingEmptyLines(['a', '', ''])).toEqual(['a']);
  });

  test('formats line ranges', () => {
    expect(formatReadLineRange({}, theme as never)).toBe('');
    expect(formatReadLineRange({ offset: 3, limit: 2 }, theme as never)).toBe(':3-4');
    expect(formatReadLineRange({ offset: 3 }, theme as never)).toBe(':3');
  });

  test('hides compact resource previews when collapsed but keeps normal previews', () => {
    const skillArgs = { path: '.pi/skills/ask-user/SKILL.md' };
    const result = { content: [{ type: 'text' as const, text: 'secret' }] };

    expect(formatReadResult(skillArgs, result, { expanded: false } as never, theme as never, true, '/repo', false)).toBe(
      '',
    );
    expect(
      formatReadResult({ path: 'src/file.txt' }, result, { expanded: false } as never, theme as never, true, '/repo', false),
    ).toContain('secret');
  });
});
