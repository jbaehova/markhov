import { markdownLanguage } from '@codemirror/lang-markdown';
import type { MarkdownParser } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { Frontmatter } from '../webview/frontmatter';
import { slugify } from '../webview/links';

const parser = (markdownLanguage.parser as MarkdownParser).configure([Frontmatter]);

function topLevel(text: string): string[] {
  const names: string[] = [];
  const cursor = parser.parse(text).cursor();
  if (cursor.firstChild()) {
    do names.push(cursor.name);
    while (cursor.nextSibling());
  }
  return names;
}

describe('Frontmatter', () => {
  it('parses a closed block at the start', () => {
    expect(topLevel('---\ntitle: x\ntags: [a]\n---\n\n# Hi\n')).toEqual(['Frontmatter', 'ATXHeading1']);
  });

  it('parses front matter that ends the document', () => {
    expect(topLevel('---\ntitle: x\n---')).toEqual(['Frontmatter']);
  });

  it('leaves an unclosed rule alone', () => {
    expect(topLevel('---\n\ntext\n')[0]).toBe('HorizontalRule');
  });

  it('only applies at the start of the document', () => {
    expect(topLevel('text\n\n---\na: b\n---\n')).not.toContain('Frontmatter');
  });
});

describe('slugify', () => {
  it('matches GitHub anchors, including Korean', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('설치 방법 (macOS)')).toBe('설치-방법-macos');
  });
});
