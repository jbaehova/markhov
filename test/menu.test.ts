import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MENU, optionCommand, settingSubmenu, WIDTHS } from '../src/menu';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const { commands, submenus, menus, configuration } = pkg.contributes;
const IN_EDITOR = "webviewId == 'markhov.editor'";

describe('right-click menu', () => {
  it('offers only values the settings accept', () => {
    for (const { key, options } of MENU) {
      const schema = configuration.properties[`markhov.${key}`];
      expect(schema, key).toBeDefined();
      const values = options.map((o) => o.value);
      if (schema.enum) expect([...values].sort(), key).toEqual([...schema.enum].sort());
      else for (const value of values) expect(value, key).toSatisfy((v: number) => v >= schema.minimum && v <= schema.maximum);
      expect(values, key).toContain(schema.default);
    }
    expect(configuration.properties['markhov.width'].enum).toEqual(Object.keys(WIDTHS));
  });

  it('lists every setting in the editor context menu', () => {
    const items = menus['webview/context'];
    for (const { key, label } of MENU) {
      expect(submenus, key).toContainEqual({ id: settingSubmenu(key), label });
      expect(items.find((item: { submenu?: string }) => item.submenu === settingSubmenu(key))?.when, key).toBe(IN_EDITOR);
    }
    for (const item of items) expect(item.when).toBe(IN_EDITOR);
  });

  it('contributes each option with a checked twin shown while it is selected', () => {
    for (const { key, options } of MENU) {
      expect(menus[settingSubmenu(key)], key).toEqual(
        options.flatMap(({ value }, index) => [
          { command: optionCommand(key, value), when: `config.markhov.${key} != '${value}'`, group: `options@${index + 1}` },
          {
            command: `${optionCommand(key, value)}.checked`,
            when: `config.markhov.${key} == '${value}'`,
            group: `options@${index + 1}`,
          },
        ]),
      );
    }
    const expected = MENU.flatMap(({ key, options }) =>
      options.flatMap(({ label, value }) => [
        { command: optionCommand(key, value), title: label, category: 'Markhov' },
        { command: `${optionCommand(key, value)}.checked`, title: `${label} ✓`, category: 'Markhov' },
      ]),
    );
    expect(commands.filter((c: { command: string }) => c.command.startsWith('markhov.set.'))).toEqual(expected);
  });

  it('keeps option commands out of the Command Palette', () => {
    const hidden = new Set(
      menus.commandPalette.filter((m: { when: string }) => m.when === 'false').map((m: { command: string }) => m.command),
    );
    for (const { command } of commands.filter((c: { command: string }) => c.command.startsWith('markhov.set.'))) {
      expect(hidden.has(command), command).toBe(true);
    }
    expect(hidden.has('markhov.openSettings')).toBe(true);
  });
});
