const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Small inline Markdown renderer for places that are not backed by the
 * editor, such as table cells in the rendered table widget. Everything is
 * escaped first; only the tags produced here end up as markup.
 */
export function renderInline(source: string): string {
  const slots: string[] = [];
  const stash = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  let text = source
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, c: string) => stash(escapeHtml(c)))
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code: string) => stash(`<code>${escapeHtml(code.trim())}</code>`));

  text = escapeHtml(text)
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/!\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, (_, alt: string) => `<span class="mh-cell-image">${alt || 'image'}</span>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label: string, href: string) => `<span class="mh-link" data-href="${href}">${label}</span>`)
    .replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*|__(\S(?:[\s\S]*?\S)?)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
    .replace(/\*(\S(?:[\s\S]*?\S)?)\*|(?<![\p{L}\p{N}])_(\S(?:[\s\S]*?\S)?)_(?![\p{L}\p{N}])/gu, (_, a?: string, b?: string) => `<em>${a ?? b}</em>`)
    .replace(/~~(\S(?:[\s\S]*?\S)?)~~/g, '<del>$1</del>');

  return text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]);
}
