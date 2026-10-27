import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import { findChrome, openInBrowser, printToPdf } from './chrome';
import { renderDocument } from './render';

const MARKDOWN_PATH = /\.(md|markdown)$/i;

function activeMarkdownUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
    if (MARKDOWN_PATH.test(input.uri.path) || input.uri.scheme === 'untitled') return input.uri;
  }
  return undefined;
}

/** Local image paths are checked on disk; remote and data URLs are left to the browser. */
function localImageExists(folder: string, workspace: string | undefined): (src: string) => boolean {
  return (src) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return true;
    let path = src.split(/[?#]/)[0];
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep the path as written.
    }
    if (!isAbsolute(path)) return existsSync(resolve(folder, path));
    return existsSync(path) || (!!workspace && existsSync(join(workspace, path)));
  };
}

async function pdfTarget(document: vscode.TextDocument): Promise<vscode.Uri | undefined> {
  if (document.uri.scheme === 'file') {
    return vscode.Uri.file(document.uri.fsPath.replace(MARKDOWN_PATH, '') + '.pdf');
  }
  return vscode.window.showSaveDialog({ filters: { PDF: ['pdf'] }, saveLabel: 'Export PDF' });
}

/** Renders the Markdown file (including unsaved edits) to a PDF next to it, then opens it. */
export async function exportPdf(uri?: vscode.Uri): Promise<void> {
  const source = uri ?? activeMarkdownUri();
  if (!source) {
    void vscode.window.showWarningMessage('Open a Markdown file to export it as PDF.');
    return;
  }
  const config = vscode.workspace.getConfiguration('markhov.pdf');
  const editor = vscode.workspace.getConfiguration('markhov');
  const chrome = findChrome(config.get<string>('chromePath'));
  if (!chrome) {
    const action = await vscode.window.showErrorMessage(
      'PDF export needs Google Chrome, Chromium, Microsoft Edge or Brave.',
      'Set Browser Path',
    );
    if (action) void vscode.commands.executeCommand('workbench.action.openSettings', 'markhov.pdf.chromePath');
    return;
  }

  const document = await vscode.workspace.openTextDocument(source);
  const target = await pdfTarget(document);
  if (!target) return;
  const name = basename(target.fsPath);
  const folder = document.uri.scheme === 'file' ? dirname(document.uri.fsPath) : dirname(target.fsPath);
  const htmlFile = join(tmpdir(), `markhov-${Date.now()}.html`);

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting ${name}` },
      async () => {
        const html = await renderDocument(document.getText(), {
          baseUrl: `${pathToFileURL(folder).href}/`,
          selfUrl: pathToFileURL(htmlFile).href,
          pageSize: config.get<'A4' | 'Letter'>('pageSize', 'A4'),
          fallbackTitle: basename(document.uri.path).replace(MARKDOWN_PATH, ''),
          imageExists: localImageExists(folder, vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath),
          text: {
            fontSize: editor.get('fontSize', 16),
            lineHeight: editor.get('lineHeight', 1.65),
            fontFamily: editor.get('fontFamily', ''),
          },
        });
        writeFileSync(htmlFile, html);
        await printToPdf(chrome, htmlFile, target.fsPath);
      },
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`PDF export failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  } finally {
    rmSync(htmlFile, { force: true });
  }

  const open = config.get<'browser' | 'default' | 'none'>('open', 'none');
  if (open === 'browser') openInBrowser(chrome, target.fsPath);
  else if (open === 'default') void vscode.env.openExternal(target);

  const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in File Explorer';
  // Not awaited: the command is done once the PDF exists.
  void vscode.window.showInformationMessage(`Exported ${name}`, 'Open', reveal).then((action) => {
    if (action === 'Open') void vscode.env.openExternal(target);
    else if (action === reveal) void vscode.commands.executeCommand('revealFileInOS', target);
  });
}
