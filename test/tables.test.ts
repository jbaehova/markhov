import { describe, expect, it } from 'vitest';
import { renderInline } from '../webview/inline';
import { parseTable, splitRow } from '../webview/tables';

describe('splitRow', () => {
  it('splits on unescaped pipes and trims cells', () => {
    expect(splitRow('| a | b \\| c |  |')).toEqual([
      { text: 'a', offset: 2 },
      { text: 'b | c', offset: 6 },
      { text: '', offset: 16 },
    ]);
  });

  it('handles rows without outer pipes', () => {
    expect(splitRow('a | b').map((c) => c.text)).toEqual(['a', 'b']);
  });
});

describe('parseTable', () => {
  it('reads alignment and pads short rows', () => {
    const source = '| Name | Qty | Note |\n|:--|--:|:-:|\n| 사과 | 3 |\n';
    const table = parseTable(source);
    expect(table.header.map((c) => c.text)).toEqual(['Name', 'Qty', 'Note']);
    expect(table.aligns).toEqual(['left', 'right', 'center']);
    expect(table.rows[0].map((c) => c.text)).toEqual(['사과', '3', '']);
    expect(source.slice(table.rows[0][0].offset, table.rows[0][0].offset + 2)).toBe('사과');
  });
});

describe('renderInline', () => {
  it('escapes HTML and renders basic formatting', () => {
    expect(renderInline('<b>x</b> **bold** *em* `a<b` ~~no~~')).toBe(
      '&lt;b&gt;x&lt;/b&gt; <strong>bold</strong> <em>em</em> <code>a&lt;b</code> <del>no</del>',
    );
  });

  it('does not format inside code spans or escapes', () => {
    expect(renderInline('`**x**` \\*y\\*')).toBe('<code>**x**</code> *y*');
  });

  it('keeps snake_case words intact', () => {
    expect(renderInline('my_var_name')).toBe('my_var_name');
  });

  it('renders links with escaped hrefs', () => {
    expect(renderInline('[site](https://a.com/?q="x")')).toBe(
      '<span class="mh-link" data-href="https://a.com/?q=&quot;x&quot;">site</span>',
    );
  });
});
