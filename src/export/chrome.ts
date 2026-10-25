import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function windowsCandidates(): string[] {
  const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(
    (r): r is string => !!r,
  );
  const apps = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Chromium\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];
  return roots.flatMap((root) => apps.map((app) => join(root, app)));
}

const CANDIDATES: Record<string, () => string[]> = {
  darwin: () => [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: windowsCandidates,
  linux: () => [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ],
};

/** The configured browser, or the first Chromium-based browser found on this machine. */
export function findChrome(configured?: string): string | null {
  if (configured?.trim()) return existsSync(configured) ? configured : null;
  return (CANDIDATES[process.platform]?.() ?? []).find((path) => existsSync(path)) ?? null;
}

/**
 * Prints an HTML file to PDF with headless Chrome. A throwaway profile keeps
 * it separate from the user's running browser, and nothing is shown on screen.
 */
export function printToPdf(chrome: string, htmlFile: string, pdfFile: string, timeout = 60_000): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'markhov-chrome-'));
  rmSync(pdfFile, { force: true });
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    '--no-pdf-header-footer',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=10000',
    `--print-to-pdf=${pdfFile}`,
    pathToFileURL(htmlFile).href,
  ];
  return new Promise((resolve, reject) => {
    execFile(chrome, args, { timeout }, (error, _stdout, stderr) => {
      rmSync(profile, { recursive: true, force: true });
      if (existsSync(pdfFile)) resolve();
      else reject(error ?? new Error(stderr.trim() || 'Chrome did not produce a PDF.'));
    });
  });
}

/** Opens a file in the given Chrome-family browser. */
export function openInBrowser(chrome: string, file: string): void {
  const app = process.platform === 'darwin' ? chrome.slice(0, chrome.indexOf('.app') + 4) : '';
  const child = app
    ? spawn('open', ['-a', app, file], { detached: true, stdio: 'ignore' })
    : spawn(chrome, [file], { detached: true, stdio: 'ignore' });
  child.unref();
}
