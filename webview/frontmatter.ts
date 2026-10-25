import type { Input } from '@lezer/common';
import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown';

const FENCE = /^(?:---|\.\.\.)[ \t]*$/;
const BLOCK = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;

/** YAML front matter at the very start of the document, parsed as its own block. */
export const Frontmatter: MarkdownConfig = {
  defineNodes: [{ name: 'Frontmatter', block: true }, 'FrontmatterMark'],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx: BlockContext, line: Line) {
        if (cx.lineStart !== 0 || !/^---[ \t]*$/.test(line.text)) return false;
        // Only commit when a closing fence exists, otherwise `---` is a regular rule.
        const input = (cx as unknown as { input?: Input }).input;
        if (!input || !BLOCK.test(input.read(0, Math.min(input.length, 64 * 1024)))) return false;

        const from = cx.lineStart;
        const children = [cx.elt('FrontmatterMark', from, from + 3)];
        while (cx.nextLine()) {
          if (FENCE.test(line.text)) {
            children.push(cx.elt('FrontmatterMark', cx.lineStart, cx.lineStart + 3));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('Frontmatter', from, cx.prevLineEnd(), children));
        return true;
      },
    },
  ],
};
