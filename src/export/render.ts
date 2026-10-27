import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Parser } from '@lezer/common';
import { highlightCode } from '@lezer/highlight';
import MarkdownIt from 'markdown-it';
import { codeHighlight } from '../../webview/highlight';
import { escapeHtml } from '../../webview/inline';
import { slugify } from '../../webview/slug';
import printCss from './print.css';

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const FENCE_INFO = /^[ \t]*(?:`{3,}|~{3,})[ \t]*([^\s`{]+)/gm;

export interface RenderOptions {
  /** URL that relative image paths resolve against, with a trailing slash. */
  baseUrl: string;
  /** URL of the HTML file itself, so `#anchor` links stay inside the PDF. */
  selfUrl: string;
  pageSize: 'A4' | 'Letter';
  /** Title when the document has neither front matter nor an H1. */
  fallbackTitle: string;
  /** Lets the caller report local images that do not exist, so they render as a placeholder. */
  imageExists?: (src: string) => boolean;
  /** The editor's text settings, so the PDF reads like the editor. */
  text?: { fontSize: number; lineHeight: number; fontFamily: string };
}

/** Blocks whose lines are all their own; the next block can only start after their last line. */
const LEAF_BLOCKS = new Set(['paragraph_open', 'heading_open', 'fence', 'code_block', 'hr', 'html_block', 'table_open']);
const BLANK_LINE = /^[\s>]*$/;

export function splitFrontmatter(text: string): { body: string; title: string | null } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { body: text, title: null };
  const title = /^title:[ \t]*(.+?)[ \t]*$/m.exec(match[1])?.[1].replace(/^(['"])(.*)\1$/, '$2') ?? null;
  return { body: text.slice(match[0].length), title };
}

/** Loads the parsers for every fenced code language used in the document. */
async function loadParsers(markdown: string): Promise<Map<string, Parser>> {
  const names = new Set([...markdown.matchAll(FENCE_INFO)].map((m) => m[1].toLowerCase()));
  const parsers = new Map<string, Parser>();
  await Promise.all(
    [...names].map(async (name) => {
      const description = LanguageDescription.matchLanguageName(languages, name, true);
      if (!description) return;
      try {
        parsers.set(name, (await description.load()).language.parser);
      } catch {
        // Unhighlighted code is still fine.
      }
    }),
  );
  return parsers;
}

function highlight(code: string, parser: Parser): string {
  let html = '';
  highlightCode(
    code,
    parser.parse(code),
    codeHighlight,
    (text, classes) => {
      html += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text);
    },
    () => {
      html += '\n';
    },
  );
  return html;
}

function createRenderer(parsers: Map<string, Parser>, options: RenderOptions) {
  // `breaks`: a single newline is a line break, exactly as the editor shows it.
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true });

  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const lang = token.info.trim().split(/\s+/)[0] ?? '';
    const code = token.content.replace(/\n$/, '');
    const parser = parsers.get(lang.toLowerCase());
    const body = parser ? highlight(code, parser) : escapeHtml(code);
    const label = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return `<pre class="code"${label}><code>${body}</code></pre>\n`;
  };

  // `- [ ] item` becomes a drawn checkbox, like in the editor.
  md.core.ruler.after('inline', 'markhov-tasks', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      const item = tokens[i - 2];
      if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || item.type !== 'list_item_open') continue;
      const first = inline.children?.[0];
      const match = first?.type === 'text' ? /^\[([ xX])\](?:[ \t]+|$)/.exec(first.content) : null;
      if (!first || !match) continue;
      const checked = match[1] !== ' ';
      first.content = first.content.slice(match[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<span class="checkbox${checked ? ' checked' : ''}"></span>`;
      inline.children!.unshift(box);
      item.attrJoin('class', checked ? 'task done' : 'task');
    }
  });

  // Ordered items keep the number written in the source, as the editor shows it,
  // instead of being renumbered from the first item.
  md.core.ruler.after('inline', 'markhov-numbers', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'list_item_open' || !token.info) continue;
      token.attrSet('value', String(Number(token.info)));
      if (token.markup === ')') token.attrJoin('class', 'paren');
    }
  });

  // Heading ids for `#anchor` links.
  md.core.ruler.after('inline', 'markhov-anchors', (state) => {
    const used = new Map<string, number>();
    state.tokens.forEach((token, i) => {
      if (token.type !== 'heading_open') return;
      const text = (state.tokens[i + 1].children ?? []).map((c) => (c.type === 'text' || c.type === 'code_inline' ? c.content : '')).join('');
      const slug = slugify(text);
      const count = used.get(slug) ?? 0;
      used.set(slug, count + 1);
      token.attrSet('id', count ? `${slug}-${count}` : slug);
    });
  });

  // Blank lines take a line of space each, as in the editor, instead of
  // collapsing into one paragraph gap. Blocks have no margins of their own.
  // Blank lines before the first block are left to the page margin.
  md.core.ruler.push('markhov-blank-lines', (state) => {
    const lines = state.src.split('\n');
    const tokens: typeof state.tokens = [];
    let cursor = 0;
    for (const token of state.tokens) {
      if (token.map && token.nesting >= 0 && token.map[0] > cursor && tokens.length) {
        let blank = 0;
        for (let n = cursor; n < token.map[0]; n++) if (BLANK_LINE.test(lines[n] ?? '')) blank++;
        if (blank) {
          const spacer = new state.Token('html_block', '', 0);
          spacer.content = `<div class="blank" style="--lines: ${blank}"></div>\n`;
          tokens.push(spacer);
        }
      }
      if (token.map && token.nesting >= 0) cursor = Math.max(cursor, LEAF_BLOCKS.has(token.type) ? token.map[1] : token.map[0]);
      tokens.push(token);
    }
    state.tokens = tokens;
  });

  const renderImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, i, opts, env, self) => {
    const src = tokens[i].attrGet('src');
    if (typeof src === 'string' && options.imageExists && !options.imageExists(src)) {
      return `<span class="missing-image">${escapeHtml(tokens[i].content || src)}</span>`;
    }
    return renderImage(tokens, i, opts, env, self);
  };

  const renderLink = md.renderer.rules.link_open ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
  md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
    const href = tokens[i].attrGet('href');
    if (typeof href === 'string' && href.startsWith('#')) tokens[i].attrSet('href', options.selfUrl + href);
    return renderLink(tokens, i, opts, env, self);
  };

  return md;
}

function firstHeading(markdown: string): string | null {
  const match = /^#[ \t]+(.+?)[ \t#]*$/m.exec(markdown);
  return match ? match[1].replace(/[*_`~]/g, '') : null;
}

/** Renders a Markdown document into a standalone, print-ready HTML page. */
export async function renderDocument(text: string, options: RenderOptions): Promise<string> {
  const { body, title } = splitFrontmatter(text.replace(/\r\n?/g, '\n'));
  const parsers = await loadParsers(body);
  const content = createRenderer(parsers, options).render(body);
  const pageTitle = title ?? firstHeading(body) ?? options.fallbackTitle;
  const lang = /[가-힣]/.test(body) ? 'ko' : 'en';
  const settings = options.text;
  // 16px in the editor prints as 10.5pt.
  const typography = settings
    ? `:root { --size: ${((10.5 * settings.fontSize) / 16).toFixed(2)}pt; --line: ${settings.lineHeight};${
        settings.fontFamily.trim() ? ` --font: ${settings.fontFamily.replace(/[<>{};]/g, '')};` : ''
      } }`
    : '';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'">
<base href="${escapeHtml(options.baseUrl)}">
<title>${escapeHtml(pageTitle)}</title>
<style>
${printCss}
@page { size: ${options.pageSize}; }
${typography}
</style>
</head>
<body>
<article class="markhov">
${content}</article>
</body>
</html>
`;
}
