# Changelog

## 0.5.0 (2026-10-27)

Markhov and the file stay in step, also while an agent edits it.

- After VS Code restarts its extensions, for example when Markhov or another extension updates, open Markhov tabs reconnect on their own. Before, they kept showing the old text until the tab was closed and opened again: edits made outside the editor, such as an agent's, never showed up, and typing in the tab was not saved.
- A tab with unsaved changes at that moment reconnects as soon as they are saved. Until then, editing in it pauses with a notice, so nothing is typed that would be lost.
- When the file changes on disk while the document has unsaved edits, as when an agent writes in the second before auto save, the change is merged in and the unsaved edits are kept. Before, VS Code ignored the change and the next save failed because the file was newer. If Markhov does not have focus at that moment, VS Code still asks on save, and Overwrite keeps both sides.
- An outside edit in several places updates just those places, so the cursor and the rest of the page stay where they are.
- Saving right after typing waits for the last keystrokes to reach the file.

## 0.4.0 (2026-10-27)

PDFs look like the editor.

- Every blank line in the document is a line of space in the PDF, as in the editor, instead of collapsing into one paragraph gap.
- Headings, quotes, rules, lists and code blocks in the PDF use the editor's sizes and spacing.
- The PDF follows the editor's font size, line height and font settings.
- Right after Markhov updates, a setting from the right-click menu that VS Code does not know yet asks to reload the window instead of failing with an error.

## 0.3.0 (2026-10-27)

Settings are a right-click away.

- Right-click in the editor to change how the page looks or how PDFs are exported. Each setting opens a submenu with a check mark next to the current value. Export to PDF is in the same menu.
- The text column width comes in five steps from Very Narrow to Very Wide. Medium is the old default width. `markhov.width` replaces `markhov.maxWidth`.
- Block quotes use the body text color instead of gray, in the editor and in PDFs.
- Headings have a little more room below them.
- Typing `- ` or `1. ` right under a paragraph shows the bullet at once, instead of turning the paragraph into a heading until the first letter.
- Enter at the end of a list item starts the next item right below it, also in lists with blank lines between items.
- Backspace on an empty item with nested items moves them out one level, so they no longer turn into a code block.
- Shift+Tab in a paragraph that sits inside a list item moves the paragraph out one level, so text indented into a list by accident can be taken back out. Tab there no longer moves the whole item.
- Cmd+K (Ctrl+K) no longer inserts a link, so VS Code shortcuts that start with Cmd+K work inside Markhov.

## 0.2.0 (2026-10-27)

List editing works the way it does in Notion, Bear or Typora.

- Tab and Shift+Tab indent from anywhere in an item and on several selected items, always to the column Markdown needs, with children moving along. Cmd+] and Cmd+[ (Ctrl on Windows and Linux) do the same.
- Numbered lists renumber themselves when items are nested, unnested or removed.
- Shift+Tab, and Enter on an empty nested item, bring the item back into its parent's list, so a bullet under `1.` comes back as `2.`.
- Typing `- ` or `1. ` on an empty item switches its kind instead of nesting a second marker on the same line; `[] ` makes it a task.
- An empty bullet under a numbered item (or a number under a bullet) no longer turns the text above it into a heading.
- Enter on an empty top-level item leaves the list with a blank line, so the next paragraph is not swallowed by the last item.
- Backspace on an empty item removes it, indentation included.
- Shift+Enter starts a new line inside the item, and Enter on that line starts the next item.
- Tab on a task item nests the next item under the bullet's text rather than after the checkbox, which Markdown read as plain text.

## 0.1.0 (2026-10-25)

First release.

- Live preview editor for Markdown files, opened on demand with Cmd+Shift+M (Ctrl+Shift+M) and swapped in place with the raw text editor.
- CommonMark and GitHub Flavored Markdown: headings, emphasis, links, images, lists, task lists, block quotes, tables, code blocks with syntax highlighting and YAML front matter.
- List editing: hanging indentation, Tab and Shift+Tab nesting, Enter to continue or leave a list.
- Formatting shortcuts, find and replace, Cmd+click to open links.
- Light and dark appearance.
- PDF export through a Chromium-based browser, saved next to the Markdown file.
