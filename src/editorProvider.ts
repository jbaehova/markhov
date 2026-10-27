import * as vscode from 'vscode';
import { Authority } from './authority';
import { DiskSync } from './diskSync';
import { type Width, WIDTHS } from './menu';
import type { HostMessage, MarkhovConfig, Resources, WebviewMessage } from './protocol';

export const VIEW_TYPE = 'markhov.editor';

/** The longest a save waits for keystrokes that are still on their way into the document. */
const FLUSH_MS = 1000;

/** What the webviews reported, for the Output panel and the integration tests. */
export const diagnostics = { ready: 0, errors: [] as string[] };
let output: vscode.OutputChannel | undefined;

function reportError(message: string): void {
  diagnostics.errors.push(message);
  output ??= vscode.window.createOutputChannel('Markhov');
  output.appendLine(`[webview] ${message}`);
}

export function readConfig(): MarkhovConfig {
  const config = vscode.workspace.getConfiguration('markhov');
  return {
    fontSize: config.get('fontSize', 16),
    lineHeight: config.get('lineHeight', 1.65),
    maxWidth: WIDTHS[config.get<Width>('width', 'medium')] ?? WIDTHS.medium,
    fontFamily: config.get('fontFamily', ''),
    colors: config.get('colors', 'bear'),
    appearance: config.get('appearance', 'auto'),
  };
}

function dirname(uri: vscode.Uri): vscode.Uri {
  const index = uri.path.lastIndexOf('/');
  return uri.with({ path: index > 0 ? uri.path.slice(0, index) : '/' });
}

function hasScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

export class MarkhovEditorProvider implements vscode.CustomTextEditorProvider {
  /** The panels this extension host serves, with the document each one shows. */
  private readonly panels = new Map<vscode.WebviewPanel, string>();
  /** One per document open in Markhov, shared by its panels. */
  private readonly disks = new Map<string, DiskSync>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Whether a panel of this extension host shows `uri` in the given editor column. */
  serves(uri: vscode.Uri, viewColumn: vscode.ViewColumn): boolean {
    const key = uri.toString();
    for (const [panel, shown] of this.panels) {
      if (shown === key && (panel.viewColumn === undefined || panel.viewColumn === viewColumn)) return true;
    }
    return false;
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.panels.set(panel, document.uri.toString());
    const webview = panel.webview;
    const folder = document.uri.scheme === 'untitled' ? undefined : dirname(document.uri);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');

    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        distUri,
        ...(folder ? [folder] : []),
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
      ],
    };
    webview.html = this.html(webview, distUri);

    const post = (message: HostMessage) => void webview.postMessage(message);
    const authority = new Authority(
      {
        getText: () => document.getText(),
        apply: (edits) => {
          const edit = new vscode.WorkspaceEdit();
          for (const { from, to, text } of edits) {
            edit.replace(
              document.uri,
              new vscode.Range(from.line, from.character, to.line, to.character),
              text,
            );
          }
          return vscode.workspace.applyEdit(edit);
        },
      },
      post,
    );

    const key = document.uri.toString();
    let disk = this.disks.get(key);
    if (!disk) this.disks.set(key, (disk = new DiskSync(document, VIEW_TYPE)));
    const detach = disk.attach(panel, authority);

    const resources: Resources = {
      baseUri: folder ? `${webview.asWebviewUri(folder).toString()}/` : null,
      workspaceUri: workspaceFolder ? `${webview.asWebviewUri(workspaceFolder.uri).toString()}/` : null,
    };

    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === document.uri.toString()) authority.documentChanged();
      }),
      // Cmd+S right after a keystroke: the save waits until the keystroke is in the document.
      vscode.workspace.onWillSaveTextDocument((event) => {
        if (event.document.uri.toString() !== document.uri.toString()) return;
        // Capped, so a stuck edit cannot hold the save up.
        event.waitUntil(Promise.race([authority.flushed(), new Promise((resolve) => setTimeout(resolve, FLUSH_MS))]));
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('markhov')) post({ type: 'config', config: readConfig() });
      }),
      webview.onDidReceiveMessage((message: WebviewMessage) => {
        switch (message.type) {
          case 'ready':
            diagnostics.ready++;
            post({ type: 'init', text: authority.text, version: authority.version, config: readConfig(), resources });
            break;
          case 'push':
            authority.push(message.version, message.updates);
            break;
          case 'pull':
            authority.pull(message.version);
            break;
          case 'focus':
            disk.setFocused(panel, message.focused);
            break;
          case 'openLink':
            void this.openLink(message.href, folder);
            break;
          case 'error':
            reportError(message.message);
            break;
        }
      }),
    ];
    panel.onDidDispose(() => {
      this.panels.delete(panel);
      subscriptions.forEach((s) => s.dispose());
      detach.dispose();
      if (!disk.attached) {
        disk.dispose();
        this.disks.delete(key);
      }
    });
  }

  private async openLink(href: string, folder: vscode.Uri | undefined): Promise<void> {
    if (hasScheme(href)) {
      const uri = vscode.Uri.parse(href);
      if (uri.scheme === 'file') {
        await vscode.commands.executeCommand('vscode.open', uri);
      } else {
        await vscode.env.openExternal(uri);
      }
      return;
    }
    if (!folder) return;
    const [path] = href.split('#');
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      // Keep the raw path when it is not valid percent-encoding.
    }
    const target = decoded.startsWith('/')
      ? vscode.Uri.joinPath(vscode.workspace.getWorkspaceFolder(folder)?.uri ?? folder.with({ path: '/' }), decoded)
      : vscode.Uri.joinPath(folder, decoded);
    if (/\.(md|markdown)$/i.test(target.path)) {
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    } else {
      await vscode.commands.executeCommand('vscode.open', target);
    }
  }

  private html(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'main.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
