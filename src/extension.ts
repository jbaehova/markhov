import * as vscode from 'vscode';
import { diagnostics, MarkhovEditorProvider, VIEW_TYPE } from './editorProvider';

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

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new MarkhovEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('markhov.toggle', async () => {
      const target = activeTarget();
      if (target) await reopenActive(target);
    }),
    vscode.commands.registerCommand('markhov.openEditor', () => reopenActive(VIEW_TYPE)),
    vscode.commands.registerCommand('markhov.openRaw', () => reopenActive('default')),
    vscode.commands.registerCommand('markhov.exportPdf', (uri?: vscode.Uri) => loadExport().exportPdf(uri)),
    // Not contributed to the palette; used by the integration tests.
    vscode.commands.registerCommand('markhov._diagnostics', () => diagnostics),
    vscode.commands.registerCommand('markhov.openWith', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) return vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

export function deactivate(): void {}
