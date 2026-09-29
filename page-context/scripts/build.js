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

const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'info'
};

const entries = [
  {
    entryPoints: [resolve(root, 'src/content/content.js')],
    outfile: resolve(root, 'src/content/content.bundle.js'),
    ...common
  },
  {
    // The shawwn floating widget, injected on all pages.
    entryPoints: [resolve(root, 'src/widget/widget.js')],
    outfile: resolve(root, 'src/widget/widget.bundle.js'),
    ...common
  }
];

const watch = process.argv.includes('--watch');

if (watch) {
  for (const opts of entries) {
    const ctx = await context(opts);
    await ctx.watch();
  }
  console.log('[build] watching src/content, src/widget and src/lib for changes...');
} else {
  for (const opts of entries) {
    await build(opts);
    console.log(`[build] wrote ${opts.outfile.replace(root + '/', '')}`);
  }
}
