/**
 * DOM utilities: visibility detection and traversal helpers.
 *
 * Functions accept an explicit `win` (window) argument so they work both in a
 * live browser (window) and under jsdom in tests. When omitted, they fall back
 * to the ambient globalThis.
 */

/** Resolve the effective window for computed-style lookups. */
function resolveWindow(node, win) {
  if (win) return win;
  const doc = node && node.ownerDocument;
  return (doc && doc.defaultView) || globalThis;
}

/**
 * Best-effort visibility check for an element.
 * Uses getComputedStyle when available and falls back to inline hints under
 * environments (like jsdom) where layout metrics are not computed.
 */
export function isVisible(element, win) {
  if (!element || element.nodeType !== 1) return false;

  const w = resolveWindow(element, win);

  // aria-hidden and hidden attribute are strong signals.
  if (element.getAttribute && element.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  if (element.hasAttribute && element.hasAttribute('hidden')) {
    return false;
  }

  let style;
  try {
    style = w.getComputedStyle ? w.getComputedStyle(element) : null;
  } catch {
    style = null;
  }

  if (style) {
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity !== '' && parseFloat(style.opacity) === 0) return false;
  } else {
    // Fallback: inspect inline style text (jsdom has limited computed styles).
    const inline = (element.getAttribute && element.getAttribute('style')) || '';
    if (/display\s*:\s*none/i.test(inline)) return false;
    if (/visibility\s*:\s*hidden/i.test(inline)) return false;
    if (/opacity\s*:\s*0(?!\.)/i.test(inline)) return false;
  }

  // Zero-size elements (only trust when layout is available).
  if (typeof element.getBoundingClientRect === 'function') {
    const rect = element.getBoundingClientRect();
    const hasLayout = rect && (rect.width || rect.height);
    // In jsdom rects are 0; don't treat that as hidden.
    const layoutAvailable = w && w.navigator && !/jsdom/i.test(w.navigator.userAgent || '');
    if (layoutAvailable && !hasLayout) return false;
  }

  return true;
}

/**
 * Depth-first walk over an element tree, descending into open shadow roots.
 * Calls `visit(el)` for every element. Closed shadow roots are inaccessible
 * and simply skipped (we never attempt to bypass them).
 */
export function walkElements(root, visit) {
  if (!root) return;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || node.nodeType !== 1) continue;
    visit(node);

    if (node.shadowRoot) {
      // Open shadow root: traverse its children too.
      const kids = node.shadowRoot.children;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

/**
 * Inline the contents of open shadow roots into the light DOM of a clone.
 * This lets the rest of the pipeline treat the tree uniformly. Best effort;
 * failures are ignored so extraction never crashes on exotic components.
 */
export function flattenShadowRoots(root, doc) {
  const d = doc || (root && root.ownerDocument) || globalThis.document;
  if (!d) return root;
  const hosts = [];
  walkElements(root, (el) => {
    if (el.shadowRoot) hosts.push(el);
  });
  for (const host of hosts) {
    try {
      const frag = d.createElement('div');
      frag.setAttribute('data-pc-shadow', 'true');
      for (const child of Array.from(host.shadowRoot.children)) {
        frag.appendChild(child.cloneNode(true));
      }
      host.appendChild(frag);
    } catch {
      // ignore inaccessible / detached shadow content
    }
  }
  return root;
}
