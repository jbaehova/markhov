import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { classify, closestBase, diffToChanges, merge } from '../src/diff';

const doc = (text: string) => Text.of(text.split('\n'));
const apply = (a: string, b: string) => diffToChanges(a, b).apply(doc(a)).toString();

function spans(a: string, b: string): [number, number, string][] {
  const out: [number, number, string][] = [];
  diffToChanges(a, b).iterChanges((fromA, toA, _fromB, _toB, inserted) => out.push([fromA, toA, inserted.toString()]));
  return out;
}

describe('diffToChanges', () => {
  it('keeps separate edits separate, so text between them keeps its place', () => {
    const a = '# Title\n\nfirst\n\nmiddle\n\nlast\n';
    const b = '# Title\n\nfirst!\n\nmiddle\n\nlast?\n';
    expect(spans(a, b)).toEqual([
      [14, 14, '!'],
      [28, 28, '?'],
    ]);
    // A cursor inside "middle" maps to itself.
    expect(diffToChanges(a, b).mapPos(18)).toBe(19);
  });

  it('keeps a cursor at the start of a paragraph with it when lines are added above', () => {
    const a = '# Notes\n\nBody text\n';
    const b = '# Notes\n\nNew line\n\nBody text\n';
    const cursor = a.indexOf('Body');
    expect(b.slice(diffToChanges(a, b).mapPos(cursor, -1))).toMatch(/^Body/);
    // The same for removed lines.
    expect(a.slice(diffToChanges(b, a).mapPos(b.indexOf('Body'), -1))).toMatch(/^Body/);
  });

  it('handles inserted and removed lines', () => {
    expect(apply('a\nb\nc\n', 'a\nx\nb\nc\n')).toBe('a\nx\nb\nc\n');
    expect(apply('a\nb\nc\n', 'a\nc\n')).toBe('a\nc\n');
    expect(apply('', 'x')).toBe('x');
    expect(apply('x', '')).toBe('');
    expect(apply('no newline', 'no newline\n')).toBe('no newline\n');
  });

  it('turns any text into any other text', () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pieces = ['a', 'b', '\n', 'cc', '- ', '\n\n', '한글'];
    const text = (length: number) => Array.from({ length }, () => pieces[random(pieces.length)]).join('');
    for (let i = 0; i < 400; i++) {
      const a = text(random(40));
      const b = random(2) ? text(random(40)) : a.slice(0, random(a.length + 1)) + text(random(5)) + a.slice(random(a.length + 1));
      expect(apply(a, b)).toBe(b);
    }
  });

  it('falls back to one span for a rewrite too large to diff line by line', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `old ${i}`).join('\n');
    const b = Array.from({ length: 1500 }, (_, i) => `new ${i}`).join('\n');
    expect(apply(a, b)).toBe(b);
    expect(spans(a, b)).toHaveLength(1);
  });
});

describe('merge', () => {
  it('keeps unsaved edits and an outside edit made elsewhere', () => {
    const base = '# Notes\n\n- one\n- two\n';
    const mine = '# Notes\n\n- one, typed\n- two\n';
    const theirs = '# Notes\n\n- one\n- two\n- three from the agent\n';
    expect(merge(base, mine, theirs)).toBe('# Notes\n\n- one, typed\n- two\n- three from the agent\n');
  });

  it('keeps both sides when they write at the same spot', () => {
    expect(merge('ab', 'aXb', 'aYb')).toBe('aYXb');
  });

  it('is the outside text when nothing is unsaved', () => {
    expect(merge('one\n', 'one\n', 'two\n')).toBe('two\n');
  });
});

describe('classify', () => {
  it('tells our own saves from outside writes', () => {
    expect(classify('a', 'a', true, [])).toBe('same');
    expect(classify('a', 'b', false, [])).toBe('reloading');
    expect(classify('a', 'ab', true, ['a', 'ab'])).toBe('ours');
    expect(classify('agent', 'ab', true, ['a', 'ab'])).toBe('outside');
  });
});

describe('closestBase', () => {
  it('finds the save an agent edited, even if its event was missed', () => {
    const lastDisk = 'title\n';
    const saved = 'title\nhello\n';
    const typing = 'title\nhello wor\n';
    const disk = 'title\nhello\nagent line\n';
    const base = closestBase(disk, [lastDisk, saved, typing]);
    expect(base).toBe(saved);
    // With the right base, the saved text is not merged in twice.
    expect(merge(base!, 'title\nhello world\n', disk)).toBe('title\nhello world\nagent line\n');
  });
});
