/**
 * Build script: bundles the content-script entry (which uses ES module imports
 * from src/lib) into a single classic script that Chrome can inject via
 * chrome.scripting.executeScript. This keeps the extraction logic as a single
 * testable source of truth under src/lib while producing a buildless-loadable
 * extension bundle.
 */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const options = {
  entryPoints: [resolve(root, 'src/content/content.js')],
  outfile: resolve(root, 'src/content/content.bundle.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'info'
};

const watch = process.argv.includes('--watch');

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[build] watching src/content and src/lib for changes...');
} else {
  await build(options);
  console.log('[build] wrote src/content/content.bundle.js');
}
