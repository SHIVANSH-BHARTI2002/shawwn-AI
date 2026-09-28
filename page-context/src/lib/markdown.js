/**
 * HTML -> Markdown conversion, optimized for LLM consumption.
 *
 * Walks a DOM subtree and emits structured Markdown that preserves headings,
 * paragraphs, lists, tables, quotes, code blocks and links. Table conversion is
 * shared with the structured JSON extractor via `tableToModel`.
 */

import { normalizeWhitespace, collapseBlankLines, resolveUrl } from '../utils/helpers.js';

const HEADING_LEVELS = { h1: '#', h2: '##', h3: '###', h4: '####', h5: '#####', h6: '######' };

/**
 * Convert an element subtree to Markdown.
 * @param {Element} root
 * @param {object} opts - { baseUrl, includeLinks, includeImages }
 * @returns {string}
 */
export function toMarkdown(root, opts = {}) {
  const ctx = {
    baseUrl: opts.baseUrl || '',
    includeLinks: opts.includeLinks !== false,
    includeImages: opts.includeImages !== false
  };
  const blocks = [];
  renderChildren(root, blocks, ctx);
  return collapseBlankLines(blocks.join('\n\n'));
}

/** Render block-level children of a node into the `blocks` accumulator. */
function renderChildren(node, blocks, ctx) {
  for (const child of Array.from(node.childNodes)) {
    renderBlock(child, blocks, ctx);
  }
}

/** Render a single node as one or more Markdown blocks. */
function renderBlock(node, blocks, ctx) {
  if (node.nodeType === 3) {
    const text = normalizeWhitespace(node.textContent);
    if (text) blocks.push(text);
    return;
  }
  if (node.nodeType !== 1) return;

  const tag = node.tagName.toLowerCase();

  if (HEADING_LEVELS[tag]) {
    const text = inline(node, ctx);
    if (text.trim()) blocks.push(`${HEADING_LEVELS[tag]} ${text.trim()}`);
    return;
  }

  switch (tag) {
    case 'p':
    case 'figcaption': {
      const text = inline(node, ctx);
      if (text.trim()) blocks.push(text.trim());
      return;
    }
    case 'br':
      return;
    case 'hr':
      blocks.push('---');
      return;
    case 'ul':
    case 'ol': {
      const list = renderList(node, ctx, 0);
      if (list.trim()) blocks.push(list);
      return;
    }
    case 'blockquote': {
      const inner = [];
      renderChildren(node, inner, ctx);
      const quoted = inner
        .join('\n\n')
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n');
      if (quoted.trim()) blocks.push(quoted);
      return;
    }
    case 'pre': {
      const codeText = node.textContent.replace(/\n+$/, '');
      const lang = detectCodeLang(node);
      blocks.push('```' + lang + '\n' + codeText + '\n```');
      return;
    }
    case 'table': {
      const md = tableToMarkdown(node);
      if (md) blocks.push(md);
      return;
    }
    case 'img': {
      if (ctx.includeImages) {
        const md = imageToMarkdown(node, ctx);
        if (md) blocks.push(md);
      }
      return;
    }
    case 'figure':
    case 'article':
    case 'section':
    case 'main':
    case 'div':
    case 'header':
    case 'aside':
    case 'details':
    default:
      // Generic container: recurse. If it has no block children, treat its
      // collected inline text as a paragraph.
      if (hasBlockChild(node)) {
        renderChildren(node, blocks, ctx);
      } else {
        const text = inline(node, ctx);
        if (text.trim()) blocks.push(text.trim());
      }
      return;
  }
}

/** True if node contains at least one block-level descendant we handle. */
function hasBlockChild(node) {
  return !!node.querySelector(
    'p, h1, h2, h3, h4, h5, h6, ul, ol, table, pre, blockquote, figure, hr, img, article, section'
  );
}

/** Render <ul>/<ol> (with nesting) to Markdown list text. */
function renderList(node, ctx, depth) {
  const ordered = node.tagName.toLowerCase() === 'ol';
  const indent = '  '.repeat(depth);
  const lines = [];
  let index = 1;

  for (const li of Array.from(node.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    const marker = ordered ? `${index}.` : '-';

    // Split the li into its own inline text and any nested lists.
    const nested = [];
    const liClone = li.cloneNode(true);
    for (const sub of Array.from(liClone.querySelectorAll(':scope > ul, :scope > ol'))) {
      nested.push(sub);
      sub.remove();
    }
    const text = inline(liClone, ctx).trim();
    lines.push(`${indent}${marker} ${text}`.trimEnd());

    for (const sub of nested) {
      const subText = renderList(sub, ctx, depth + 1);
      if (subText) lines.push(subText);
    }
    index += 1;
  }
  return lines.join('\n');
}

/** Convert inline-level content of a node to Markdown text. */
function inline(node, ctx) {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out += child.textContent.replace(/\s+/g, ' ');
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    switch (tag) {
      case 'strong':
      case 'b': {
        const t = inline(child, ctx).trim();
        if (t) out += `**${t}**`;
        break;
      }
      case 'em':
      case 'i': {
        const t = inline(child, ctx).trim();
        if (t) out += `*${t}*`;
        break;
      }
      case 'code': {
        const t = child.textContent.trim();
        if (t) out += '`' + t + '`';
        break;
      }
      case 'br':
        out += '\n';
        break;
      case 'a': {
        const t = inline(child, ctx).trim() || '';
        if (ctx.includeLinks) {
          const href = resolveUrl(child.getAttribute('href') || '', ctx.baseUrl);
          if (href && t && !href.startsWith('javascript:')) {
            out += `[${t}](${href})`;
          } else {
            out += t;
          }
        } else {
          out += t;
        }
        break;
      }
      case 'img': {
        if (ctx.includeImages) out += imageToMarkdown(child, ctx);
        break;
      }
      default:
        out += inline(child, ctx);
    }
  }
  return out.replace(/[ \t]{2,}/g, ' ');
}

/** Guess a code language from class hints like `language-js`. */
function detectCodeLang(pre) {
  const code = pre.querySelector('code') || pre;
  const cls = (typeof code.className === 'string' ? code.className : '') || '';
  const m = cls.match(/(?:language|lang)-([a-z0-9+#-]+)/i);
  return m ? m[1] : '';
}

/** Build `![alt](src "title")` from an <img>. */
function imageToMarkdown(img, ctx) {
  const src = resolveUrl(img.getAttribute('src') || img.getAttribute('data-src') || '', ctx.baseUrl);
  if (!src) return '';
  const alt = normalizeWhitespace(img.getAttribute('alt') || '');
  const title = normalizeWhitespace(img.getAttribute('title') || '');
  return `![${alt}](${src}${title ? ` "${title}"` : ''})`;
}

/**
 * Parse a <table> into a { headers, rows } model shared by Markdown and JSON.
 * Handles a header row in <thead> or the first row's <th> cells.
 */
export function tableToModel(table) {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return { headers: [], rows: [] };

  const cellText = (cell) => normalizeWhitespace(cell.textContent);

  let headers = [];
  let bodyRows = rows;

  const thead = table.querySelector('thead');
  if (thead) {
    const headRow = thead.querySelector('tr');
    if (headRow) {
      headers = Array.from(headRow.querySelectorAll('th,td')).map(cellText);
      bodyRows = rows.filter((r) => !thead.contains(r));
    }
  } else if (rows[0].querySelector('th')) {
    headers = Array.from(rows[0].querySelectorAll('th,td')).map(cellText);
    bodyRows = rows.slice(1);
  }

  const data = bodyRows
    .map((r) => Array.from(r.querySelectorAll('td,th')).map(cellText))
    .filter((r) => r.some((c) => c !== ''));

  return { headers, rows: data };
}

/** Render a <table> element to a GitHub-flavored Markdown table. */
export function tableToMarkdown(table) {
  const { headers, rows } = tableToModel(table);
  if (!headers.length && !rows.length) return '';

  const width = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const head = headers.length ? headers : new Array(width).fill('');
  const padded = [...head];
  while (padded.length < width) padded.push('');

  const escape = (c) => (c || '').replace(/\|/g, '\\|');
  const lines = [];
  lines.push('| ' + padded.map(escape).join(' | ') + ' |');
  lines.push('| ' + padded.map(() => '---').join(' | ') + ' |');
  for (const r of rows) {
    const cells = [...r];
    while (cells.length < width) cells.push('');
    lines.push('| ' + cells.map(escape).join(' | ') + ' |');
  }
  return lines.join('\n');
}
