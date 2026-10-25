import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', './export.js'],
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/export/exportPdf.ts'],
    outfile: 'dist/export.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    loader: { '.css': 'text' },
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/main.ts'],
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    target: 'es2022',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
