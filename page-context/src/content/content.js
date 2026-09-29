/**
 * Content-script entry point.
 *
 * This module is bundled by esbuild into `content.bundle.js` (an IIFE classic
 * script) which the service worker injects on demand via
 * chrome.scripting.executeScript. It listens for extraction requests from the
 * popup and runs the extraction engine against the live rendered DOM.
 *
 * The heavy lifting lives in ../lib/* (pure, testable modules). This file only
 * wires those modules to the runtime messaging and the live document.
 */

import { extractPage } from '../lib/extractor.js';

const PING = 'PAGECONTEXT_PING';
const EXTRACT = 'PAGECONTEXT_EXTRACT';
const HIGHLIGHT = 'PAGECONTEXT_HIGHLIGHT';

/** Optional short wait so late-rendering SPA content can settle. */
function wait(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * Locate a page section (for a citation) and scroll + briefly highlight it.
 * Strategy, most reliable first:
 *   1. Match a heading element whose text equals the citation's section.
 *   2. Fall back to the first element containing a snippet of the cited text.
 * We never fabricate brittle selectors; if nothing matches we report failure
 * and the UI can fall back gracefully.
 */
function highlightSource({ section, headingPath, text }) {
  const target =
    findHeading(section) ||
    findHeading((headingPath && headingPath[headingPath.length - 1]) || '') ||
    findByText(text);

  if (!target) return { ok: false, matched: false };

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashHighlight(target);
  return { ok: true, matched: true };
}

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findHeading(sectionText) {
  const wanted = normalize(sectionText);
  if (!wanted) return null;
  const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (const h of headings) {
    if (normalize(h.textContent) === wanted) return h;
  }
  // Looser contains-match as a second pass.
  for (const h of headings) {
    if (normalize(h.textContent).includes(wanted)) return h;
  }
  return null;
}

function findByText(text) {
  const snippet = normalize(text).slice(0, 40);
  if (!snippet) return null;
  const blocks = document.querySelectorAll('p,li,td,th,blockquote,pre,div,span');
  for (const el of blocks) {
    // Only leaf-ish elements to avoid selecting huge containers.
    if (el.children.length > 3) continue;
    if (normalize(el.textContent).includes(snippet)) return el;
  }
  return null;
}

function flashHighlight(el) {
  const prev = {
    outline: el.style.outline,
    transition: el.style.transition,
    background: el.style.backgroundColor
  };
  el.style.transition = 'background-color 0.3s ease, outline 0.3s ease';
  el.style.outline = '3px solid #4f46e5';
  el.style.backgroundColor = 'rgba(79, 70, 229, 0.12)';
  setTimeout(() => {
    el.style.outline = prev.outline;
    el.style.backgroundColor = prev.background;
    el.style.transition = prev.transition;
  }, 2500);
}

async function handleExtract(settings) {
  await wait(Math.min(Math.max(Number(settings?.waitForPageMs) || 0, 0), 1000));

  const result = extractPage({
    doc: document,
    win: window,
    url: location.href,
    settings
  });

  const hasContent =
    (result.content.text && result.content.text.trim().length > 0) ||
    (result.content.markdown && result.content.markdown.trim().length > 0);

  if (!hasContent) {
    return { ok: false, error: 'empty', message: 'This page has no extractable content.' };
  }
  return { ok: true, result };
}

// Guard against double-injection: define the listener only once.
if (!window.__pageContextInjected) {
  window.__pageContextInjected = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (message.type === PING) {
      sendResponse({ ok: true, ready: true });
      return false;
    }

    if (message.type === EXTRACT) {
      handleExtract(message.settings)
        .then(sendResponse)
        .catch((err) => {
          // Detailed error to console for developers; friendly message to UI.
          console.error('[PageContext] extraction failed:', err);
          sendResponse({
            ok: false,
            error: 'extraction_failed',
            message: 'Unable to extract this page.'
          });
        });
      return true; // async response
    }

    if (message.type === HIGHLIGHT) {
      try {
        sendResponse(highlightSource(message));
      } catch (err) {
        console.error('[PageContext] highlight failed:', err);
        sendResponse({ ok: false, matched: false });
      }
      return false;
    }

    return false;
  });
}
