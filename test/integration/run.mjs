import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

const root = resolve(import.meta.dirname, '../..');
const scratch = process.env.MARKHOV_SCRATCH ?? mkdtempSync(join(tmpdir(), 'markhov-'));
const workspace = join(scratch, 'workspace');
cpSync(join(root, 'harness'), workspace, { recursive: true });
const results = join(scratch, 'results.txt');

try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'test/integration/suite.cjs'),
    extensionTestsEnv: { MARKHOV_RESULTS: results },
    launchArgs: [
      workspace,
      '--disable-extensions',
      `--user-data-dir=${join(scratch, 'user-data')}`,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
    ],
  });
} finally {
  try {
    console.log(readFileSync(results, 'utf8'));
  } catch {
    console.log('no results written');
  }
}
