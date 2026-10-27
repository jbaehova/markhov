# Changelog

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
