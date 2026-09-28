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

/** Optional short wait so late-rendering SPA content can settle. */
function wait(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
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

    return false;
  });
}
