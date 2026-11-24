import { describe, expect, test } from 'bun:test';
import { __testing } from '../extensions/herdr-split.ts';

const { buildSplitArgs, errorMessage, findPane } = __testing;

describe('herdr-split helpers', () => {
  test('finds the pane showing a terminal', () => {
    const ls = {
      spaces: [
        { tabs: [{ terminals: [{ terminal: 't1', pane: 'pA' }] }] },
        {
          tabs: [
            {
              terminals: [
                { terminal: 't2', pane: null },
                { terminal: 't3', pane: 'pC' },
              ],
            },
          ],
        },
      ],
    };
    expect(findPane(ls, 't3')).toBe('pC');
    expect(findPane(ls, 't2')).toBeNull();
    expect(findPane(ls, 'missing')).toBeNull();
    expect(findPane({}, 't1')).toBeNull();
  });

  test('builds a pane.split command that forks the session in cwd', () => {
    const args = buildSplitArgs('right', 'pA', '/tmp/work dir', '/tmp/s "1".jsonl', '/bin/zsh');
    expect(args.slice(0, 2)).toEqual(['do', 'pane.split']);

    const payload = JSON.parse(args[2]!);
    expect(payload.direction).toBe('right');
    expect(payload.pane).toBe('pA');
    expect(payload.argv).toEqual([
      '/bin/zsh',
      '-lic',
      'cd -- "$1" && pi --fork "$2"; exec "$0" -l',
      '/bin/zsh',
      '/tmp/work dir',
      '/tmp/s "1".jsonl',
    ]);
  });

  test('reads herdr-app JSON errors from stdout', () => {
    const err = Object.assign(new Error('Command failed'), { stdout: '{"error":"no such pane"}' });
    expect(errorMessage(err)).toBe('no such pane');
    expect(errorMessage(Object.assign(new Error('boom'), { stdout: 'not json' }))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });
});
