/**
 * Core extraction engine. Orchestrates metadata extraction, DOM cleaning,
 * main-content detection, structured extraction, Markdown/text generation and
 * serialization into the stable JSON payload consumed by the UI (and, later, a
 * RAG backend).
 *
 * All functions accept an explicit `doc`/`win` so the engine is fully testable
 * under jsdom without relying on ambient globals.
 */

import { DEFAULT_SETTINGS, CONTENT_POSITIVE_TAGS, CONTENT_NEGATIVE_TAGS } from '../utils/constants.js';
import {
  normalizeWhitespace,
  collapseBlankLines,
  countWords,
  countCharacters,
  getDomain,
  resolveUrl,
  truncateAtBoundary
} from '../utils/helpers.js';
import { isVisible, flattenShadowRoots } from './dom.js';
import { cleanDOM } from './cleaner.js';
import { toMarkdown, tableToModel, tableToMarkdown } from './markdown.js';

/**
 * Extract structured content from a document.
 * @param {object} params - { doc, win, url, settings }
 * @returns {object} stable extraction payload (see serialize())
 */
export function extractPage({ doc, win, url, settings } = {}) {
  const d = doc || globalThis.document;
  const w = win || (d && d.defaultView) || globalThis;
  const cfg = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const pageUrl = url || (d && d.location ? d.location.href : '');

  const metadata = extractMetadata(d, pageUrl);

  // Work on a cleaned clone; never mutate the live DOM.
  const cleanedRoot = cleanDOM(d, cfg);
  flattenShadowRoots(cleanedRoot, d);

  const mainEl = detectMainContent(cleanedRoot, d);

  const structure = {
    headings: extractHeadings(mainEl),
    paragraphs: extractParagraphs(mainEl),
    lists: extractLists(mainEl),
    tables: extractTables(mainEl),
    links: cfg.includeLinks ? extractLinks(mainEl, pageUrl) : [],
    images: cfg.includeImages ? extractImages(mainEl, pageUrl) : []
  };

  let markdown = toMarkdown(mainEl, {
    baseUrl: pageUrl,
    includeLinks: cfg.includeLinks,
    includeImages: cfg.includeImages
  });

  // Prepend a title heading if the content doesn't already start with one.
  if (metadata.title && !/^#\s/.test(markdown)) {
    markdown = `# ${metadata.title}\n\n${markdown}`;
  }
  markdown = collapseBlankLines(markdown);

  let text = extractPlainText(mainEl);

  const maxLen = cfg.maxContentLength || DEFAULT_SETTINGS.maxContentLength;
  const mdTrunc = truncateAtBoundary(markdown, maxLen);
  const textTrunc = truncateAtBoundary(text, maxLen);
  markdown = mdTrunc.text;
  text = textTrunc.text;
  const truncated = mdTrunc.truncated || textTrunc.truncated;

  return serialize({
    metadata,
    markdown,
    text,
    structure,
    truncated,
    maxContentLength: maxLen,
    includeMetadata: cfg.includeMetadata
  });
}

/* ------------------------------------------------------------------ *
 * Metadata
 * ------------------------------------------------------------------ */

export function extractMetadata(doc, pageUrl) {
  const meta = (selector, attr = 'content') => {
    const el = doc.querySelector(selector);
    return el ? normalizeWhitespace(el.getAttribute(attr) || '') : '';
  };

  const title =
    meta('meta[property="og:title"]') ||
    normalizeWhitespace(doc.querySelector('title') ? doc.querySelector('title').textContent : '') ||
    normalizeWhitespace(doc.querySelector('h1') ? doc.querySelector('h1').textContent : '');

  const description =
    meta('meta[name="description"]') || meta('meta[property="og:description"]');

  const canonicalEl = doc.querySelector('link[rel="canonical"]');
  const canonicalUrl = canonicalEl ? resolveUrl(canonicalEl.getAttribute('href') || '', pageUrl) : '';

  const language =
    (doc.documentElement && doc.documentElement.getAttribute('lang')) ||
    meta('meta[property="og:locale"]') ||
    '';

  const author =
    meta('meta[name="author"]') ||
    meta('meta[property="article:author"]') ||
    meta('meta[name="twitter:creator"]');

  const publishedDate =
    meta('meta[property="article:published_time"]') ||
    meta('meta[name="date"]') ||
    meta('meta[itemprop="datePublished"]');

  return {
    title,
    url: pageUrl,
    domain: getDomain(pageUrl),
    language: normalizeWhitespace(language),
    description,
    canonicalUrl,
    author,
    publishedDate
  };
}

/* ------------------------------------------------------------------ *
 * Main content detection
 * ------------------------------------------------------------------ */

/**
 * Identify the primary content container. Prefers semantic elements, then
 * ARIA roles, then falls back to heuristic scoring of candidate blocks.
 */
export function detectMainContent(root, doc) {
  const body = root.querySelector('body') || root;

  const semantic =
    body.querySelector('main') ||
    body.querySelector('[role="main"]') ||
    body.querySelector('article') ||
    body.querySelector('[role="article"]');
  if (semantic && hasSubstance(semantic)) return semantic;

  // Heuristic scoring over candidate containers.
  const candidates = body.querySelectorAll('article, section, div, main');
  let best = null;
  let bestScore = -Infinity;
  for (const el of candidates) {
    const score = scoreElement(el, doc);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best && bestScore > 0) return best;
  return body;
}

/** True if an element has a reasonable amount of textual content. */
function hasSubstance(el) {
  return (el.textContent || '').trim().length > 40;
}

/** Score a container: content signals up, navigation/noise signals down. */
function scoreElement(el, doc) {
  const win = (doc && doc.defaultView) || globalThis;
  if (!isVisible(el, win)) return -Infinity;

  const tag = el.tagName.toLowerCase();
  if (CONTENT_NEGATIVE_TAGS.includes(tag)) return -Infinity;

  let score = 0;
  for (const [posTag, weight] of Object.entries(CONTENT_POSITIVE_TAGS)) {
    score += el.querySelectorAll(posTag).length * weight;
  }

  // Penalize link-dense blocks (navigation, menus).
  const text = (el.textContent || '').trim();
  const linkText = Array.from(el.querySelectorAll('a'))
    .map((a) => a.textContent || '')
    .join('');
  if (text.length > 0) {
    const linkDensity = linkText.length / text.length;
    if (linkDensity > 0.5) score -= 20;
  }

  // Penalize noise-y class/id names.
  const idClass = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`.toLowerCase();
  if (/(nav|menu|sidebar|footer|header|comment|advert|promo)/.test(idClass)) score -= 10;
  if (/(content|article|post|main|story|body)/.test(idClass)) score += 8;

  return score;
}

/* ------------------------------------------------------------------ *
 * Structured extraction
 * ------------------------------------------------------------------ */

export function extractHeadings(root) {
  return Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .map((h) => ({
      level: Number(h.tagName.substring(1)),
      text: normalizeWhitespace(h.textContent)
    }))
    .filter((h) => h.text);
}

export function extractParagraphs(root) {
  return Array.from(root.querySelectorAll('p'))
    .map((p) => normalizeWhitespace(p.textContent))
    .filter((t) => t.length > 0);
}

export function extractLists(root) {
  return Array.from(root.querySelectorAll('ul,ol'))
    .filter((list) => !list.closest('li')) // top-level lists only; nested captured inside
    .map((list) => ({
      ordered: list.tagName.toLowerCase() === 'ol',
      items: Array.from(list.children)
        .filter((c) => c.tagName && c.tagName.toLowerCase() === 'li')
        .map((li) => normalizeWhitespace(li.textContent))
        .filter((t) => t.length > 0)
    }))
    .filter((l) => l.items.length > 0);
}

export function extractTables(root) {
  return Array.from(root.querySelectorAll('table'))
    .map((table) => {
      const model = tableToModel(table);
      return { ...model, markdown: tableToMarkdown(table) };
    })
    .filter((t) => t.headers.length || t.rows.length);
}

export function extractLinks(root, pageUrl) {
  const seen = new Set();
  const links = [];
  for (const a of root.querySelectorAll('a[href]')) {
    // Skip links inside obvious navigation containers.
    if (a.closest('nav')) continue;
    const text = normalizeWhitespace(a.textContent);
    const href = resolveUrl(a.getAttribute('href') || '', pageUrl);
    if (!text || !href) continue;
    if (href.startsWith('javascript:') || href.startsWith('#')) continue;
    const key = `${text}::${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text, url: href });
  }
  return links;
}

export function extractImages(root, pageUrl) {
  const seen = new Set();
  const images = [];
  for (const img of root.querySelectorAll('img')) {
    const src = resolveUrl(img.getAttribute('src') || img.getAttribute('data-src') || '', pageUrl);
    if (!src || src.startsWith('data:')) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    images.push({
      alt: normalizeWhitespace(img.getAttribute('alt') || ''),
      src,
      title: normalizeWhitespace(img.getAttribute('title') || '')
    });
  }
  return images;
}

/* ------------------------------------------------------------------ *
 * Plain text
 * ------------------------------------------------------------------ */

/**
 * Extract readable plain text preserving block boundaries as newlines.
 * Avoids the flattened single-blob problem of naive innerText usage.
 */
export function extractPlainText(root) {
  const blocks = [];
  const blockSelector = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,figcaption';
  const nodes = root.querySelectorAll(blockSelector);
  if (nodes.length) {
    for (const el of nodes) {
      // Skip cells whose text is already captured by row-level handling? Keep
      // simple: include each block's own text.
      const t = normalizeWhitespace(el.textContent);
      if (t) blocks.push(t);
    }
  } else {
    const t = normalizeWhitespace(root.textContent);
    if (t) blocks.push(t);
  }
  return collapseBlankLines(blocks.join('\n\n'));
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

/** Assemble the stable payload object returned to the UI / future backend. */
export function serialize({
  metadata,
  markdown,
  text,
  structure,
  truncated,
  maxContentLength,
  includeMetadata
}) {
  const page = {
    title: metadata.title,
    url: metadata.url,
    domain: metadata.domain,
    language: metadata.language,
    description: metadata.description,
    canonicalUrl: metadata.canonicalUrl
  };
  if (includeMetadata) {
    page.author = metadata.author;
    page.publishedDate = metadata.publishedDate;
  }

  return {
    page,
    content: {
      markdown,
      text,
      wordCount: countWords(text),
      characterCount: countCharacters(text)
    },
    structure,
    metadata: {
      extractedAt: new Date().toISOString(),
      truncated: Boolean(truncated),
      maxContentLength
    }
  };
}
