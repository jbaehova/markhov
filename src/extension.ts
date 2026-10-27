import * as vscode from 'vscode';
import { diagnostics, MarkhovEditorProvider, VIEW_TYPE } from './editorProvider';
import { MENU, optionCommand } from './menu';
import { reopenOrphanedTabs } from './orphans';

const MARKDOWN_PATH = /\.(md|markdown)$/i;

type Target = typeof VIEW_TYPE | 'default';

/**
 * Swaps the active tab between the raw text editor and Markhov in place.
 * `reopenActiveEditorWith` is what "Reopen Editor With..." runs: it replaces
 * the tab at the same position and carries unsaved changes across.
 */
async function reopenActive(target: Target): Promise<void> {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  if (!(input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom)) return;
  try {
    await vscode.commands.executeCommand('reopenActiveEditorWith', target);
  } catch {
    // Fallback if the internal command ever disappears: open, then close the old tab.
    await vscode.commands.executeCommand('vscode.openWith', input.uri, target, tab!.group.viewColumn);
    const stale = tab!.group.tabs.find((t) => t.input === input);
    if (stale) await vscode.window.tabGroups.close(stale, true);
  }
}

function activeTarget(): Target | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) return 'default';
  if (input instanceof vscode.TabInputText && MARKDOWN_PATH.test(input.uri.path)) return VIEW_TYPE;
  return undefined;
}

/**
 * PDF export bundles every code language parser, so it lives in its own
 * file (dist/export.js) that is only loaded the first time it is used.
 */
function loadExport(): typeof import('./export/exportPdf') {
  return require('./export.js');
}

/** Changes a setting where it takes effect: in the workspace if it is set there, otherwise for the user. */
async function updateSetting(key: string, value: string | number): Promise<void> {
  const config = vscode.workspace.getConfiguration('markhov');
  const target =
    config.inspect(key)?.workspaceValue === undefined
      ? vscode.ConfigurationTarget.Global
      : vscode.ConfigurationTarget.Workspace;
  try {
    await config.update(key, value, target);
  } catch {
    // Right after an update, VS Code knows only the old version's settings until the window reloads.
    const reload = 'Reload Window';
    const choice = await vscode.window.showWarningMessage('Reload the window to finish updating Markhov.', reload);
    if (choice === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/** Commands behind the editor's right-click menu (see menu.ts). */
function registerMenu(context: vscode.ExtensionContext): vscode.Disposable[] {
  const options = MENU.flatMap(({ key, options }) =>
    options.flatMap(({ value }) => {
      const command = optionCommand(key, value);
      const set = () => updateSetting(key, value);
      return [vscode.commands.registerCommand(command, set), vscode.commands.registerCommand(`${command}.checked`, set)];
    }),
  );
  return [
    ...options,
    vscode.commands.registerCommand('markhov.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    ),
  ];
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MarkhovEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    reopenOrphanedTabs(provider),
    vscode.commands.registerCommand('markhov.toggle', async () => {
      const target = activeTarget();
      if (target) await reopenActive(target);
    }),
    vscode.commands.registerCommand('markhov.openEditor', () => reopenActive(VIEW_TYPE)),
    vscode.commands.registerCommand('markhov.openRaw', () => reopenActive('default')),
    // From the editor's right-click menu the argument is the webview's context, not a file.
    vscode.commands.registerCommand('markhov.exportPdf', (uri?: unknown) =>
      loadExport().exportPdf(uri instanceof vscode.Uri ? uri : undefined),
    ),
    // Not contributed to the palette; used by the integration tests.
    vscode.commands.registerCommand('markhov._diagnostics', () => diagnostics),
    vscode.commands.registerCommand('markhov.openWith', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) return vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    ...registerMenu(context),
  );
}

export function deactivate(): void {}
