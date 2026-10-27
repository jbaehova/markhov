// Runs inside a VS Code Extension Development Host (see run.mjs).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const VIEW_TYPE = 'markhov.editor';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, predicate, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function tabsFor(uri) {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input && t.input.uri && t.input.uri.toString() === uri.toString());
}

const activeInput = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input;
const isMarkhov = (input) => input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE;
const isText = (input) => input instanceof vscode.TabInputText;

const checks = [];

async function check(name, fn) {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (error) {
    checks.push(`FAIL ${name} :: ${error.message}`);
  }
}

exports.run = async function run() {
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const uri = vscode.Uri.joinPath(folder, 'sample.md');
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((e) => e.insert(new vscode.Position(5, 0), 'UNSAVED LINE\n\n'));

  await check('raw editor starts dirty', () => assert.ok(doc.isDirty));

  await check('toggle opens Markhov in place', async () => {
    await vscode.commands.executeCommand('markhov.toggle');
    await waitFor('Markhov tab', () => isMarkhov(activeInput()));
    const tabs = tabsFor(uri);
    assert.equal(tabs.length, 1, `expected one tab, got ${tabs.length}`);
  });

  await check('unsaved changes survive the switch', () => {
    assert.ok(doc.isDirty, 'document is no longer dirty');
    assert.ok(doc.getText().includes('UNSAVED LINE'));
  });

  await check('webview starts and asks for the document', () =>
    waitFor('webview ready', async () => (await vscode.commands.executeCommand('markhov._diagnostics')).ready >= 1),
  );

  await check('outside edits are accepted while Markhov is open', async () => {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), '<!-- external -->\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await sleep(300);
  });

  await check('a file written on disk while the document has unsaved edits is merged in', async () => {
    // What an agent does: edit the file as saved, not knowing about the unsaved lines.
    fs.writeFileSync(uri.fsPath, fs.readFileSync(uri.fsPath, 'utf8') + '\nAGENT LINE\n');
    // With Markhov focused the document is reverted to the file first, so wait for the merged text.
    await waitFor('merged agent line', () => doc.getText().includes('AGENT LINE') && doc.getText().includes('UNSAVED LINE'), 5000);
    assert.ok(doc.getText().startsWith('<!-- external -->\n'), 'outside edit lost');
    assert.equal(doc.getText().match(/AGENT LINE/g).length, 1, 'agent line merged twice');
  });

  await check('toggle goes back to raw text in place', async () => {
    await vscode.commands.executeCommand('markhov.toggle');
    await waitFor('text tab', () => isText(activeInput()));
    const tabs = tabsFor(uri);
    assert.equal(tabs.length, 1, `expected one tab, got ${tabs.length}`);
    assert.ok(doc.isDirty);
    assert.ok(doc.getText().startsWith('<!-- external -->\n'));
    assert.ok(doc.getText().includes('UNSAVED LINE'));
  });

  await check('reopening Markhov again works', async () => {
    await vscode.commands.executeCommand('markhov.toggle');
    await waitFor('Markhov tab', () => isMarkhov(activeInput()));
    await waitFor('second webview ready', async () => (await vscode.commands.executeCommand('markhov._diagnostics')).ready >= 2);
    // Give the code-block language chunk time to load inside the webview.
    await sleep(2000);
  });

  await check('webview reported no errors', async () => {
    const { errors } = await vscode.commands.executeCommand('markhov._diagnostics');
    assert.deepEqual(errors, []);
  });

  await check('Export to PDF writes a PDF next to the file', async () => {
    await vscode.workspace.getConfiguration('markhov.pdf').update('open', 'none', vscode.ConfigurationTarget.Global);
    const pdf = uri.fsPath.replace(/\.md$/, '.pdf');
    fs.rmSync(pdf, { force: true });
    await vscode.commands.executeCommand('markhov.exportPdf', uri);
    assert.ok(fs.existsSync(pdf), 'no PDF');
    const head = fs.readFileSync(pdf).subarray(0, 5).toString();
    assert.equal(head, '%PDF-');
    assert.ok(fs.statSync(pdf).size > 10_000, `PDF too small: ${fs.statSync(pdf).size}`);
  });

  await check('Cmd+Shift+M keybinding is contributed for both editors', () => {
    const pkg = vscode.extensions.all.find((e) => e.packageJSON.name === 'markhov').packageJSON;
    const whens = pkg.contributes.keybindings.filter((k) => k.mac === 'cmd+shift+m').map((k) => k.when);
    assert.equal(whens.length, 2);
  });

  fs.writeFileSync(path.join(process.env.MARKHOV_RESULTS), checks.join('\n') + '\n');
  if (checks.some((c) => c.startsWith('FAIL'))) throw new Error(checks.join('\n'));
};
