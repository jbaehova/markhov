import { Text } from '@codemirror/state';
import * as vscode from 'vscode';
import { type Authority, normalizeEol } from './authority';
import { classify, closestBase, diffToChanges, merge } from './diff';

/** How many recent texts of the document are kept. A save writes one of them; an outside write almost never does. */
const RECENT = 50;
/** Lets a burst of watcher events (atomic writes, several edits in a row) settle before the file is read. */
const SETTLE_MS = 100;
/** VS Code reloads a clean document by itself; this is how long it gets before the file is looked at again. */
const RECHECK_MS = 500;

interface Client {
  panel: vscode.WebviewPanel;
  authority: Authority;
  focused: boolean;
}

/**
 * Keeps a document that has unsaved edits in step with its file. VS Code
 * does not load a file that changes on disk while the document is dirty,
 * and the next save then fails because the file is newer, so an agent's
 * edit made between typing and auto save never shows up. This merges such a
 * change into the document, keeping the unsaved edits.
 */
export class DiskSync implements vscode.Disposable {
  private readonly clients = new Set<Client>();
  private readonly recent: string[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  /** The file's text as last seen on disk; undefined while the sync is off. */
  private lastDisk: string | undefined;
  /** Set when a merged change is in the document but VS Code still expects the old file, so saving would ask. */
  private stale = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checking = false;
  private rechecked = false;

  constructor(
    private readonly document: vscode.TextDocument,
    private readonly viewType: string,
  ) {
    this.remember();
    if (document.uri.scheme !== 'file') return;
    const folder = vscode.Uri.joinPath(document.uri, '..');
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '*'), false, false, true);
    const changed = (uri: vscode.Uri) => {
      if (uri.toString() !== document.uri.toString()) return;
      this.rechecked = false;
      this.schedule(SETTLE_MS);
    };
    this.subscriptions.push(
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === document && event.contentChanges.length) this.remember();
      }),
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (saved === document) this.stale = false;
      }),
    );
    void this.start();
  }

  attach(panel: vscode.WebviewPanel, authority: Authority): vscode.Disposable {
    const client: Client = { panel, authority, focused: false };
    this.clients.add(client);
    return { dispose: () => this.clients.delete(client) };
  }

  get attached(): number {
    return this.clients.size;
  }

  /** The webview reports where keyboard focus is; a focused Markhov editor is what revert acts on. */
  setFocused(panel: vscode.WebviewPanel, focused: boolean): void {
    for (const client of this.clients) if (client.panel === panel) client.focused = focused;
    if (focused && this.stale) void this.settle((current) => current);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subscriptions.forEach((s) => s.dispose());
  }

  private text(): string {
    return normalizeEol(this.document.getText());
  }

  private remember(): void {
    const text = this.text();
    if (this.recent[this.recent.length - 1] === text) return;
    this.recent.push(text);
    if (this.recent.length > RECENT) this.recent.shift();
  }

  private async start(): Promise<void> {
    const disk = await this.read();
    // Only a file that decodes to the document's own text can be compared; other encodings are left to VS Code.
    if (disk === undefined || (!this.document.isDirty && disk !== this.text())) return;
    this.lastDisk = disk;
  }

  private async read(): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.document.uri);
      return normalizeEol(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return undefined;
    }
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), ms);
  }

  private async check(): Promise<void> {
    if (this.lastDisk === undefined) return;
    if (this.checking) return this.schedule(SETTLE_MS);
    this.checking = true;
    try {
      const disk = await this.read();
      if (disk === undefined) return;
      const current = this.text();
      switch (classify(disk, current, this.document.isDirty, this.recent)) {
        case 'same':
          this.stale = false;
          this.lastDisk = disk;
          break;
        case 'ours':
          this.lastDisk = disk;
          break;
        case 'reloading':
          // If typing made the document dirty before VS Code got to it, the reload was skipped; look once more.
          if (!this.rechecked) {
            this.rechecked = true;
            this.schedule(RECHECK_MS);
          }
          return;
        case 'outside': {
          const base = closestBase(disk, [this.lastDisk, ...this.recent]) ?? this.lastDisk;
          this.lastDisk = disk;
          await this.settle((now) => merge(base, now, disk), disk);
          break;
        }
      }
      this.rechecked = false;
    } finally {
      this.checking = false;
    }
  }

  /**
   * Puts the text `build` makes from the document into it, with client
   * pushes held so no keystroke lands in between. When a Markhov editor for
   * the document has focus, the document is first reverted to the file, so
   * VS Code knows the new file and saves without a conflict. Otherwise the
   * text waits in the document and VS Code asks on save, where Overwrite
   * keeps both sides.
   */
  private async settle(build: (current: string) => string, disk = this.lastDisk): Promise<void> {
    const client = this.clients.values().next().value;
    if (!client) return;
    await client.authority.hold(async () => {
      const before = this.text();
      let target = build(before);
      let reverted = false;
      if (this.canRevert()) {
        await vscode.commands.executeCommand('workbench.action.files.revert');
        reverted = !this.document.isDirty;
        // The file may have changed again since it was read; take that change in too.
        const loaded = this.text();
        if (loaded !== before) target = merge(disk ?? before, target, loaded);
      }
      await this.replace(target);
      this.stale = !reverted && this.document.isDirty;
    });
  }

  /** Revert acts on the active editor, so it is only used when that is certainly this document in Markhov. */
  private canRevert(): boolean {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const active =
      input instanceof vscode.TabInputCustom &&
      input.viewType === this.viewType &&
      input.uri.toString() === this.document.uri.toString();
    return active && [...this.clients].some((c) => c.focused && c.panel.active);
  }

  private async replace(target: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = this.text();
      if (current === target) return;
      const doc = Text.of(current.split('\n'));
      const position = (offset: number) => {
        const line = doc.lineAt(offset);
        return new vscode.Position(line.number - 1, offset - line.from);
      };
      const edit = new vscode.WorkspaceEdit();
      diffToChanges(current, target).iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        edit.replace(this.document.uri, new vscode.Range(position(fromA), position(toA)), inserted.toString());
      });
      // Fails when the document changed in the meantime; the edit is then worked out again.
      if (await vscode.workspace.applyEdit(edit)) return;
    }
  }
}
