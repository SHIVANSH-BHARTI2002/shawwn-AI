import { describe, it, expect } from 'vitest';
import {
  normalizeWhitespace,
  countWords,
  getDomain,
  resolveUrl,
  isRestrictedUrl,
  slugifyFilename,
  truncateAtBoundary,
  formatNumber
} from '../src/utils/helpers.js';

describe('helpers', () => {
  it('normalizes whitespace', () => {
    expect(normalizeWhitespace('  a\n\t b   c ')).toBe('a b c');
  });

  it('counts words', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countWords('   ')).toBe(0);
  });

  it('extracts domain and strips www', () => {
    expect(getDomain('https://www.amazon.in/x/y')).toBe('amazon.in');
    expect(getDomain('not a url')).toBe('');
  });

  it('resolves relative urls', () => {
    expect(resolveUrl('/a', 'https://x.com/b')).toBe('https://x.com/a');
    expect(resolveUrl('https://y.com/z', 'https://x.com')).toBe('https://y.com/z');
  });

  it('detects restricted urls', () => {
    expect(isRestrictedUrl('chrome://extensions')).toBe(true);
    expect(isRestrictedUrl('https://chromewebstore.google.com/x')).toBe(true);
    expect(isRestrictedUrl('https://example.com')).toBe(false);
    expect(isRestrictedUrl('')).toBe(true);
  });

  it('slugifies filenames safely', () => {
    expect(slugifyFilename('Sony WH-1000XM5 / Review!')).toBe('sony-wh-1000xm5-review');
    expect(slugifyFilename('***')).toBe('page');
  });

  it('truncates at a natural boundary', () => {
    const text = 'First paragraph.\n\nSecond paragraph is here and is long enough.';
    const { text: out, truncated } = truncateAtBoundary(text, 20);
    expect(truncated).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it('does not truncate short text', () => {
    const { truncated } = truncateAtBoundary('short', 100);
    expect(truncated).toBe(false);
  });

  it('formats numbers with separators', () => {
    expect(formatNumber(2431)).toBe('2,431');
    expect(formatNumber(999)).toBe('999');
  });
});
