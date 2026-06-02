import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import { __testing } from '../extensions/grep-highlight.ts';

const {
  getTextOutput,
  renderGrepCall,
  renderGrepLine,
  renderTruncationWarning,
  sanitizeDisplayText,
  shortenPath,
} = __testing;

const theme = {
  bold: (value: string) => `<b>${value}</b>`,
  fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
};

describe('grep-highlight rendering helpers', () => {
  test('sanitizes ANSI and control characters from text output', () => {
    expect(sanitizeDisplayText('\u001b[31mred\u001b[0m\u0000\u001f\tkeep')).toBe('red\tkeep');
    expect(
      getTextOutput({
        content: [
          { type: 'text', text: 'one\u001b[31m' },
          { type: 'image' },
          { type: 'text', text: 'two\u0007' },
        ],
      }),
    ).toBe('one\ntwo');
  });

  test('shortens home-relative paths', () => {
    expect(shortenPath(`${os.homedir()}/project/file.ts`)).toBe('~/project/file.ts');
    expect(shortenPath('/var/tmp/file.ts')).toBe('/var/tmp/file.ts');
  });

  test('renders grep calls including invalid args and optional fields', () => {
    expect(
      renderGrepCall({ pattern: 'TODO', path: '/repo', glob: '*.ts', limit: 5 }, theme as never),
    ).toContain('<syntaxKeyword>/TODO/</syntaxKeyword>');

    expect(renderGrepCall({ pattern: 42, path: {} }, theme as never)).toContain(
      '<error>[invalid arg]</error>',
    );
  });

  test('renders match, context, and plain output lines', () => {
    expect(renderGrepLine('src/a.ts:12: const x = 1', theme as never)).toContain(
      '<accent>src/a.ts</accent>',
    );
    expect(renderGrepLine('src/a.ts-13- context', theme as never)).toContain(
      '<syntaxFunction>src/a.ts</syntaxFunction>',
    );
    expect(renderGrepLine('plain', theme as never)).toBe('<toolOutput>plain</toolOutput>');
  });

  test('renders truncation warning details', () => {
    expect(
      renderTruncationWarning(
        { matchLimitReached: 100, linesTruncated: true, truncation: { truncated: true, maxBytes: 10 } },
        theme as never,
      ),
    ).toContain('[Truncated: 100 matches limit, 10B limit, some lines truncated]');

    expect(renderTruncationWarning(undefined, theme as never)).toBe('');
  });
});
