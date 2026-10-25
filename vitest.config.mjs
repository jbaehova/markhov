import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // Mirrors esbuild's text loader for the print stylesheet.
      name: 'css-as-text',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('/src/export/print.css')) return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
      },
    },
  ],
  test: { include: ['test/**/*.test.ts'] },
});
