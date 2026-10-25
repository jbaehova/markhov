import { describe, expect, it } from 'vitest';
import { renderDocument, splitFrontmatter } from '../src/export/render';

const options = {
  baseUrl: 'file:///notes/',
  selfUrl: 'file:///tmp/markhov-1.html',
  pageSize: 'A4' as const,
  fallbackTitle: 'untitled',
};

const body = (html: string) => html.slice(html.indexOf('<article'), html.indexOf('</article>'));

describe('splitFrontmatter', () => {
  it('extracts the title and strips the block', () => {
    expect(splitFrontmatter('---\ntitle: "My Note"\ntags: [a]\n---\n# Hi\n')).toEqual({ body: '# Hi\n', title: 'My Note' });
  });
});

describe('renderDocument', () => {
  it('uses the front matter title, then the first heading, then the file name', async () => {
    expect(await renderDocument('---\ntitle: Plan\n---\n# Other\n', options)).toContain('<title>Plan</title>');
    expect(await renderDocument('# 오늘의 노트\n', options)).toContain('<title>오늘의 노트</title>');
    expect(await renderDocument('text\n', options)).toContain('<title>untitled</title>');
  });

  it('renders task items as drawn checkboxes', async () => {
    const html = body(await renderDocument('- [x] done\n- [ ] todo\n- plain\n', options));
    expect(html).toContain('<li class="task done"><span class="checkbox checked"></span>done</li>');
    expect(html).toContain('<li class="task"><span class="checkbox"></span>todo</li>');
    expect(html).toContain('<li>plain</li>');
  });

  it('highlights fenced code with the editor token classes', async () => {
    const html = body(await renderDocument('```ts\nconst a = 1;\n```\n', options));
    expect(html).toContain('<pre class="code" data-lang="ts">');
    expect(html).toContain('<span class="mh-tok-keyword">const</span>');
    expect(html).toContain('<span class="mh-tok-number">1</span>');
  });

  it('keeps anchor links inside the document and adds heading ids', async () => {
    const html = body(await renderDocument('# 설치 방법\n\n[top](#설치-방법)\n', options));
    expect(html).toContain('<h1 id="설치-방법">');
    expect(html).toContain('href="file:///tmp/markhov-1.html#%EC%84%A4%EC%B9%98-%EB%B0%A9%EB%B2%95"');
  });

  it('replaces missing local images with a placeholder', async () => {
    const html = body(await renderDocument('![gone](nope.png) ![ok](ok.png)\n', { ...options, imageExists: (src) => src === 'ok.png' }));
    expect(html).toContain('<span class="missing-image">gone</span>');
    expect(html).toContain('<img src="ok.png" alt="ok">');
  });

  it('blocks scripts in the generated page', async () => {
    const html = await renderDocument('<script>alert(1)</script>\n', options);
    expect(html).toContain(`content="script-src 'none'"`);
  });
});

describe('line breaks', () => {
  it('keeps single newlines as line breaks, like the editor shows them', async () => {
    expect(body(await renderDocument('first line\nsecond line\n', options))).toContain('<p>first line<br>\nsecond line</p>');
  });
});

describe('ordered lists', () => {
  it('keep the numbers written in the source', async () => {
    const html = body(await renderDocument('1. a\n2. b\n10. c\n', options));
    expect(html).toContain('<li value="1">a</li>');
    expect(html).toContain('<li value="10">c</li>');
  });

  it('keep repeated numbers instead of counting up', async () => {
    const html = body(await renderDocument('1. a\n1. b\n', options));
    expect(html.match(/<li value="1">/g)).toHaveLength(2);
  });

  it('keep the parenthesis delimiter', async () => {
    expect(body(await renderDocument('3) a\n', options))).toContain('<li value="3" class="paren">a</li>');
  });
});
