/**
 * DOM cleaning: works on a *clone* of the document so the live page is never
 * modified. Removes always-noise tags, optionally removes structural chrome
 * (nav/footer/aside) based on settings, and uses conservative scoring to drop
 * likely UI noise (ads, cookie banners, share widgets) without deleting real
 * content.
 */

import {
  ALWAYS_REMOVE_TAGS,
  STRUCTURAL_REMOVE_TAGS,
  NOISE_HINTS,
  NOISE_REMOVE_THRESHOLD
} from '../utils/constants.js';
import { walkElements, isVisible } from './dom.js';

/**
 * Produce a cleaned clone of `documentElement`.
 *
 * Visibility is evaluated against the *live* document (which has layout /
 * computed styles) and mapped onto the clone, because a detached clone has no
 * computed styles. We tag hidden live nodes, then drop the matching tags in the
 * clone.
 *
 * @param {Document} doc - the live document (not mutated)
 * @param {object} settings - user settings controlling structural removal
 * @returns {Element} cloned <html> element, cleaned in place
 */
export function cleanDOM(doc, settings = {}) {
  const clone = doc.documentElement.cloneNode(true);

  // Path-based hidden removal must run first, while clone and live tree are
  // structurally identical (index paths line up).
  removeHidden(clone, doc);
  removeTags(clone, ALWAYS_REMOVE_TAGS);

  for (const [flag, tags] of Object.entries(STRUCTURAL_REMOVE_TAGS)) {
    if (settings[flag]) removeTags(clone, tags);
  }

  if (settings.removeAdvertisements || settings.removeSidebars || settings.removeNavigation) {
    removeNoiseByScore(clone, settings);
  }

  return clone;
}

/**
 * Remove elements that are hidden in the *live* document.
 *
 * The clone is detached and therefore has no computed styles, so visibility is
 * judged against the live tree. For each hidden live element we compute a child
 * index path from documentElement and delete the node at the same path in the
 * clone. This avoids mutating the live page while still honoring CSS-based
 * hiding (display:none, visibility:hidden, opacity:0, [hidden], aria-hidden).
 */
function removeHidden(clone, doc) {
  const win = (doc && doc.defaultView) || globalThis;
  const liveRoot = doc.documentElement;
  const hiddenPaths = [];

  walkElements(liveRoot, (el) => {
    if (el === liveRoot) return;
    // Skip elements already inside a hidden ancestor (path removal handles them).
    if (!isVisible(el, win)) {
      const path = indexPath(el, liveRoot);
      if (path) hiddenPaths.push(path);
    }
  });

  // Remove in reverse document order so a removal never shifts the index of a
  // still-pending target. Compare paths lexicographically; the later (greater)
  // path is removed first. This correctly orders both deeper nodes and later
  // siblings ahead of earlier ones.
  hiddenPaths.sort((a, b) => comparePaths(b, a));
  for (const path of hiddenPaths) {
    const node = nodeAtPath(clone, path);
    if (node) node.remove();
  }
}

/**
 * Lexicographic comparison of two index paths. Returns positive if `a` comes
 * after `b` in document order, negative if before, 0 if equal. A path that is a
 * prefix of another (ancestor) is considered earlier.
 */
function comparePaths(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Child-index path from `root` down to `el` (array of indices), or null. */
function indexPath(el, root) {
  const path = [];
  let cur = el;
  while (cur && cur !== root) {
    const parent = cur.parentElement;
    if (!parent) return null;
    const idx = Array.prototype.indexOf.call(parent.children, cur);
    if (idx < 0) return null;
    path.unshift(idx);
    cur = parent;
  }
  return cur === root ? path : null;
}

/** Resolve a child-index path against the clone's documentElement. */
function nodeAtPath(cloneRoot, path) {
  let node = cloneRoot;
  for (const idx of path) {
    if (!node || !node.children || idx >= node.children.length) return null;
    node = node.children[idx];
  }
  return node;
}

/** Remove every element matching the given tag names. */
function removeTags(root, tags) {
  if (!tags || !tags.length) return;
  const selector = tags.join(',');
  const matches = root.querySelectorAll(selector);
  for (const el of matches) el.remove();
}

/**
 * Score elements against noise hints (id, class, role, aria-label) and remove
 * those at/above the threshold. Elements that contain substantial text or
 * multiple paragraphs are protected from removal.
 */
function removeNoiseByScore(root, settings) {
  const candidates = [];
  walkElements(root, (el) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    // Only consider container-ish elements as removable noise blocks.
    if (['div', 'section', 'aside', 'ul', 'span', 'header', 'form'].includes(tag)) {
      candidates.push(el);
    }
  });

  for (const el of candidates) {
    if (!el.isConnected && !root.contains(el)) continue;
    const score = noiseScore(el, settings);
    if (score >= NOISE_REMOVE_THRESHOLD && !isContentRich(el)) {
      el.remove();
    }
  }
}

/** Combine id/class/role/aria hints into a numeric noise score. */
function noiseScore(el, settings) {
  const hintText = [
    el.id || '',
    typeof el.className === 'string' ? el.className : '',
    el.getAttribute ? el.getAttribute('role') || '' : '',
    el.getAttribute ? el.getAttribute('aria-label') || '' : '',
    el.getAttribute ? el.getAttribute('data-testid') || '' : ''
  ]
    .join(' ')
    .toLowerCase();

  let score = 0;
  for (const hint of NOISE_HINTS) {
    if (hintText.includes(hint)) {
      score += 1;
      // Ad/cookie/consent are high-confidence noise; weight them more.
      if (settings.removeAdvertisements && ['advertisement', 'advert', 'ads', 'adslot', 'cookie', 'consent', 'sponsor'].includes(hint)) {
        score += 1;
      }
    }
  }
  return score;
}

/**
 * Protect elements that look like genuine content: enough text or multiple
 * block-level children (paragraphs, headings, list items, tables).
 */
function isContentRich(el) {
  const text = (el.textContent || '').trim();
  if (text.length > 600) return true;
  const blocks = el.querySelectorAll('p, h1, h2, h3, h4, li, table, pre, blockquote');
  if (blocks.length >= 4) return true;
  return false;
}
