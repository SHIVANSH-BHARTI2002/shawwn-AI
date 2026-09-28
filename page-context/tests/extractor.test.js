import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeDoc } from './helpers.js';
import { extractPage, extractMetadata, detectMainContent } from '../src/lib/extractor.js';
import { cleanDOM } from '../src/lib/cleaner.js';
import { DEFAULT_SETTINGS } from '../src/utils/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(resolve(__dirname, 'fixtures/sample.html'), 'utf8');

function extractFixture(overrides = {}) {
  const { doc, win } = makeDoc(fixtureHtml, 'https://example.com/sample');
  return extractPage({
    doc,
    win,
    url: 'https://example.com/sample',
    settings: { ...DEFAULT_SETTINGS, ...overrides }
  });
}

describe('metadata extraction', () => {
  it('extracts core metadata fields', () => {
    const { doc } = makeDoc(fixtureHtml, 'https://example.com/sample');
    const meta = extractMetadata(doc, 'https://example.com/sample');
    expect(meta.title).toBe('PageContext Test Fixture');
    expect(meta.domain).toBe('example.com');
    expect(meta.language).toBe('en');
    expect(meta.description).toContain('local test page');
    expect(meta.canonicalUrl).toBe('https://example.com/sample');
    expect(meta.author).toBe('Test Author');
    expect(meta.publishedDate).toBe('2026-01-15T10:00:00Z');
  });
});

describe('cleaning', () => {
  it('removes scripts, noscript and structural chrome', () => {
    const { doc } = makeDoc(fixtureHtml);
    const clone = cleanDOM(doc, DEFAULT_SETTINGS);
    expect(clone.querySelector('script')).toBeNull();
    expect(clone.querySelector('noscript')).toBeNull();
    expect(clone.querySelector('nav')).toBeNull();
    expect(clone.querySelector('footer')).toBeNull();
    expect(clone.querySelector('aside')).toBeNull();
  });
});

describe('main content detection', () => {
  it('prefers the article/main region', () => {
    const { doc } = makeDoc(fixtureHtml);
    const clone = cleanDOM(doc, DEFAULT_SETTINGS);
    const main = detectMainContent(clone, doc);
    expect(main.textContent).toContain('Sony WH-1000XM5');
    expect(main.textContent).not.toContain('All rights reserved');
  });
});

describe('full extraction', () => {
  let result;
  beforeAll(() => {
    result = extractFixture();
  });

  it('produces the stable payload shape', () => {
    expect(result).toHaveProperty('page');
    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('structure');
    expect(result).toHaveProperty('metadata.extractedAt');
    expect(result.content).toHaveProperty('markdown');
    expect(result.content).toHaveProperty('text');
    expect(result.content).toHaveProperty('wordCount');
    expect(result.content).toHaveProperty('characterCount');
  });

  it('preserves headings, list, table and code in markdown', () => {
    const md = result.content.markdown;
    expect(md).toContain('# Sony WH-1000XM5');
    expect(md).toContain('## About this item');
    expect(md).toContain('- 30 hours battery life');
    expect(md).toContain('| Specification | Value |');
    expect(md).toContain('| Brand | Sony |');
    expect(md).toContain('> Best headphones');
    expect(md).toContain('```bash');
  });

  it('excludes hidden and noise content', () => {
    const all = result.content.markdown + result.content.text;
    expect(all).not.toContain('Hidden promotional text');
    expect(all).not.toContain('Also hidden text');
    expect(all).not.toContain('All rights reserved');
    expect(all).not.toContain('We use cookies');
  });

  it('extracts structured headings, lists and tables', () => {
    expect(result.structure.headings.some((h) => h.text === 'Sony WH-1000XM5')).toBe(true);
    expect(result.structure.lists.length).toBeGreaterThan(0);
    expect(result.structure.tables.length).toBe(1);
    expect(result.structure.tables[0].headers).toEqual(['Specification', 'Value']);
    expect(result.structure.tables[0].rows).toContainEqual(['Brand', 'Sony']);
  });

  it('extracts meaningful links and image metadata', () => {
    expect(result.structure.links.some((l) => l.url.endsWith('/full-review'))).toBe(true);
    // navigation links should be excluded
    expect(result.structure.links.some((l) => l.text === 'Home')).toBe(false);
    expect(result.structure.images.length).toBe(1);
    expect(result.structure.images[0].alt).toBe('Sony WH-1000XM5 headphones');
  });

  it('computes word and character counts', () => {
    expect(result.content.wordCount).toBeGreaterThan(0);
    expect(result.content.characterCount).toBeGreaterThan(0);
  });

  it('respects includeLinks/includeImages settings', () => {
    const r = extractFixture({ includeLinks: false, includeImages: false });
    expect(r.structure.links).toEqual([]);
    expect(r.structure.images).toEqual([]);
  });
});

describe('edge cases', () => {
  it('handles an empty body', () => {
    const { doc, win } = makeDoc('<body></body>');
    const r = extractPage({ doc, win, url: 'https://example.com/empty' });
    expect(r.content.text).toBe('');
    expect(r.content.wordCount).toBe(0);
  });

  it('handles malformed html without throwing', () => {
    const { doc, win } = makeDoc('<body><h1>Title<p>unclosed <ul><li>item</body>');
    expect(() => extractPage({ doc, win, url: 'https://example.com/x' })).not.toThrow();
    const r = extractPage({ doc, win, url: 'https://example.com/x' });
    expect(r.content.markdown).toContain('Title');
  });

  it('truncates very large content at the configured limit', () => {
    const paras = Array.from({ length: 500 }, (_, i) => `<p>Paragraph number ${i} with some filler words here.</p>`).join('');
    const { doc, win } = makeDoc(`<body><main>${paras}</main></body>`);
    const r = extractPage({ doc, win, url: 'https://example.com/big', settings: { maxContentLength: 2000 } });
    expect(r.metadata.truncated).toBe(true);
    expect(r.content.markdown.length).toBeLessThanOrEqual(2000);
  });

  it('extracts a page that has only navigation without crashing', () => {
    const { doc, win } = makeDoc('<body><nav><a href="/a">A</a><a href="/b">B</a></nav></body>');
    const r = extractPage({ doc, win, url: 'https://example.com/navonly' });
    expect(r).toHaveProperty('content');
  });
});
