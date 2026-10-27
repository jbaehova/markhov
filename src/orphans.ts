import * as vscode from 'vscode';
import { type MarkhovEditorProvider, VIEW_TYPE } from './editorProvider';

/** How long a visible tab may go unserved before it counts as orphaned. Resolving a tab takes milliseconds. */
const GRACE_MS = 1000;
/** Right after activation the window may still be starting up, so the first check waits longer. */
const STARTUP_MS = 3000;

/**
 * When VS Code restarts the extension host (after an extension update, or
 * "Restart Extension Host"), Markhov tabs stay open but nothing reconnects
 * their webviews to the new host. They keep showing the old text, outside
 * edits (agents, git, the raw editor) never reach them, and typing in them
 * goes nowhere. The new host finds such tabs and reopens them in place.
 *
 * Only visible tabs are judged: a background tab restored with the window is
 * not resolved until it is shown, so it looks the same as an orphan.
 */
export function reopenOrphanedTabs(provider: MarkhovEditorProvider): vscode.Disposable {
  // Each tab gets one attempt, so a tab that fails to resolve is not reopened in a loop.
  const tried = new Set<string>();
  const notBefore = Date.now() + STARTUP_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const check = async () => {
    if (running) return schedule();
    running = true;
    try {
      for (const group of vscode.window.tabGroups.all) {
        const tab = group.activeTab;
        const input = tab?.input;
        if (!tab || !(input instanceof vscode.TabInputCustom) || input.viewType !== VIEW_TYPE) continue;
        // Closing a dirty tab would ask to save; it is checked again once auto save or Cmd+S cleans it.
        if (tab.isDirty || provider.serves(input.uri, group.viewColumn)) continue;
        const key = `${group.viewColumn} ${input.uri}`;
        if (tried.has(key)) continue;
        tried.add(key);
        await reopen(tab, input.uri);
      }
    } catch (error) {
      console.error('[markhov]', error);
    } finally {
      running = false;
    }
  };

  function schedule(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void check(), Math.max(GRACE_MS, notBefore - Date.now()));
  }

  schedule();
  const subscription = vscode.window.tabGroups.onDidChangeTabs(schedule);
  return {
    dispose() {
      clearTimeout(timer);
      subscription.dispose();
    },
  };
}

/**
 * Swaps the tab for a fresh Markhov editor without moving focus. A raw text
 * tab stands in meanwhile, so the group stays open and the new tab lands
 * where the old one was.
 */
async function reopen(tab: vscode.Tab, uri: vscode.Uri): Promise<void> {
  const { group, isPreview } = tab;
  const options: vscode.TextDocumentShowOptions = { viewColumn: group.viewColumn, preserveFocus: true, preview: false };
  const textTab = () =>
    group.tabs.find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
  const hadTextTab = textTab() !== undefined;

  await vscode.commands.executeCommand('vscode.openWith', uri, 'default', options);
  if (!(await vscode.window.tabGroups.close(tab, true))) return;
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { ...options, preview: isPreview });
  const standIn = hadTextTab ? undefined : textTab();
  if (standIn && !standIn.isDirty) await vscode.window.tabGroups.close(standIn, true);
}
