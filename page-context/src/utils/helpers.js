/**
 * Small pure helpers shared across the extension.
 * No DOM globals are referenced at module scope, so this is test-friendly.
 */

import { RESTRICTED_URL_PREFIXES } from './constants.js';

/** Collapse runs of whitespace into single spaces and trim. */
export function normalizeWhitespace(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

/** Collapse 3+ consecutive blank lines down to a single blank line. */
export function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

/** Count words in a string (whitespace separated, ignoring empties). */
export function countWords(text) {
  if (!text) return 0;
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/** Count characters in a string. */
export function countCharacters(text) {
  return text ? text.length : 0;
}

/** Extract the hostname from a URL, tolerating malformed input. */
export function getDomain(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Resolve a possibly-relative href against a base URL. */
export function resolveUrl(href, base) {
  if (!href) return '';
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/** True if the URL is a browser-internal / restricted page. */
export function isRestrictedUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return RESTRICTED_URL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Turn a page title into a safe filename (without extension).
 * Falls back to "page" when nothing usable remains.
 */
export function slugifyFilename(title, fallback = 'page') {
  const base = normalizeWhitespace(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return base || fallback;
}

/**
 * Truncate text at a natural boundary at or before `maxLength`.
 * Prefers (in order): paragraph break, sentence end, word break, hard cut.
 * Returns the possibly-truncated text plus a `truncated` flag.
 */
export function truncateAtBoundary(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return { text, truncated: false };
  }
  const window = text.slice(0, maxLength);

  const boundaries = [
    window.lastIndexOf('\n\n'),
    window.lastIndexOf('\n'),
    Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? ')
    ),
    window.lastIndexOf(' ')
  ];

  // Accept the first boundary that keeps at least 60% of the window,
  // so we don't truncate absurdly early on content with few breaks.
  const minKeep = Math.floor(maxLength * 0.6);
  let cut = maxLength;
  for (const b of boundaries) {
    if (b >= minKeep) {
      cut = b;
      break;
    }
  }

  return { text: text.slice(0, cut).trimEnd(), truncated: true };
}

/** Format an integer with thousands separators (locale-independent). */
export function formatNumber(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
