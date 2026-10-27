// Settings that the editor's right-click menu can change. Each option is a
// pair of commands contributed in package.json: one shown while the option is
// not selected, and a `.checked` twin with a check mark shown while it is,
// because extensions cannot put check marks on their menu items.
// test/menu.test.ts keeps package.json in step with this list.

/** Width of the text column in pixels for each markhov.width value. */
export const WIDTHS = {
  veryWide: 1080,
  quiteWide: 880,
  medium: 720,
  quiteNarrow: 640,
  veryNarrow: 560,
} as const;

export type Width = keyof typeof WIDTHS;

export interface MenuOption {
  label: string;
  value: string | number;
}

export interface MenuSetting {
  /** Setting key under `markhov.`, such as `width` or `pdf.open`. */
  key: string;
  label: string;
  options: MenuOption[];
}

export const MENU: MenuSetting[] = [
  {
    key: 'width',
    label: 'Width',
    options: [
      { label: 'Very Wide', value: 'veryWide' },
      { label: 'Quite Wide', value: 'quiteWide' },
      { label: 'Medium', value: 'medium' },
      { label: 'Quite Narrow', value: 'quiteNarrow' },
      { label: 'Very Narrow', value: 'veryNarrow' },
    ],
  },
  {
    key: 'fontSize',
    label: 'Font Size',
    options: [14, 15, 16, 17, 18, 20].map((size) => ({ label: `${size} px`, value: size })),
  },
  {
    key: 'lineHeight',
    label: 'Line Spacing',
    options: [
      { label: '1.4', value: 1.4 },
      { label: '1.5', value: 1.5 },
      { label: '1.65', value: 1.65 },
      { label: '1.8', value: 1.8 },
      { label: '2.0', value: 2 },
    ],
  },
  {
    key: 'appearance',
    label: 'Appearance',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'Light', value: 'light' },
      { label: 'Dark', value: 'dark' },
    ],
  },
  {
    key: 'colors',
    label: 'Colors',
    options: [
      { label: 'Markhov', value: 'bear' },
      { label: 'VS Code Theme', value: 'vscode' },
    ],
  },
  {
    key: 'pdf.pageSize',
    label: 'PDF Page Size',
    options: [
      { label: 'A4', value: 'A4' },
      { label: 'Letter', value: 'Letter' },
    ],
  },
  {
    key: 'pdf.open',
    label: 'After PDF Export',
    options: [
      { label: "Don't Open", value: 'none' },
      { label: 'Open in Browser', value: 'browser' },
      { label: 'Open in Default App', value: 'default' },
    ],
  },
];

/** Command that sets `markhov.<key>` to the value; `<command>.checked` does the same. */
export function optionCommand(key: string, value: string | number): string {
  return `markhov.set.${key}.${value}`;
}

/** Submenu of the editor's right-click menu that lists the options of a setting. */
export function settingSubmenu(key: string): string {
  return `markhov.menu.${key}`;
}
