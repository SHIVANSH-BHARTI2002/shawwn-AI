/**
 * Background service worker (MV3, module type).
 *
 * Responsibilities:
 *  - On request from the popup, ensure the content bundle is injected into the
 *    active tab, then ask it to extract the rendered DOM.
 *  - Guard against restricted URLs where content scripts cannot run.
 *  - Persist the latest extraction to chrome.storage.local (single entry).
 *
 * The worker keeps all chrome.* interactions isolated from the extraction
 * logic, which runs entirely inside the content script.
 */

import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../utils/constants.js';
import { isRestrictedUrl } from '../utils/helpers.js';
import { createApiClient } from '../api/client.js';

const CONTENT_BUNDLE = 'src/content/content.bundle.js';
const PING = 'PAGECONTEXT_PING';
const EXTRACT = 'PAGECONTEXT_EXTRACT';
const HIGHLIGHT = 'PAGECONTEXT_HIGHLIGHT';
const REQUEST_EXTRACTION = 'PAGECONTEXT_REQUEST_EXTRACTION';
const REQUEST_HIGHLIGHT = 'PAGECONTEXT_REQUEST_HIGHLIGHT';
const BACKEND = 'PAGECONTEXT_BACKEND';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === REQUEST_EXTRACTION) {
    runExtraction(message.settings, message.tabId)
      .then(sendResponse)
      .catch((err) => {
        console.error('[PageContext] service worker error:', err);
        sendResponse({ ok: false, error: 'internal', message: 'Something went wrong.' });
      });
    return true; // async
  }

  if (message && message.type === REQUEST_HIGHLIGHT) {
    runHighlight(message)
      .then(sendResponse)
      .catch((err) => {
        console.error('[PageContext] highlight error:', err);
        sendResponse({ ok: false, matched: false });
      });
    return true; // async
  }

  if (message && message.type === BACKEND) {
    proxyBackend(message.action, message.params || {})
      .then(sendResponse)
      .catch((err) => {
        console.error('[PageContext] backend proxy error:', err);
        sendResponse({ ok: false, code: 'PROXY_ERROR', message: 'Backend request failed.' });
      });
    return true; // async
  }

  return false;
});

/**
 * Proxy backend calls from content-script widgets through the extension origin.
 * This keeps requests off the page origin (avoiding CORS/host-permission
 * pitfalls) and centralizes the API client.
 */
async function proxyBackend(action, params) {
  const api = await createApiClient();
  switch (action) {
    case 'health':
      return api.health();
    case 'checkDocument':
      return api.checkDocument(params.url, params.contentHash);
    case 'indexDocument':
      return api.indexDocument(params.pageResult);
    case 'sendChatMessage':
      return api.sendChatMessage(
        params.documentId,
        params.message,
        params.conversationId,
        params.attachments
      );
    case 'getConversation':
      return api.getConversation(params.conversationId);
    default:
      return { ok: false, code: 'UNKNOWN_ACTION', message: `Unknown action: ${action}` };
  }
}

/** Ensure the content script is present, then ask it to highlight a section. */
async function runHighlight(message) {
  const tabId = message.tabId;
  if (!tabId) return { ok: false, matched: false };
  try {
    await ensureContentScript(tabId);
    return await sendMessageToTab(tabId, {
      type: HIGHLIGHT,
      section: message.section,
      headingPath: message.headingPath,
      text: message.text
    });
  } catch (err) {
    console.error('[PageContext] highlight forwarding failed:', err);
    return { ok: false, matched: false };
  }
}

/**
 * Orchestrate a full extraction cycle.
 * If an explicit `tabId` is provided (e.g. from the shawwn chat window), that
 * tab is targeted; otherwise the current window's active tab is used.
 */
async function runExtraction(settings, tabId) {
  const tab = tabId != null ? await getTabById(tabId) : await getActiveTab();
  if (!tab) {
    return { ok: false, error: 'no_tab', message: 'No active tab found.' };
  }
  if (!tab.id || isRestrictedUrl(tab.url)) {
    return {
      ok: false,
      error: 'restricted',
      message: 'This page cannot be accessed by browser extensions.'
    };
  }

  try {
    await ensureContentScript(tab.id);
  } catch (err) {
    console.error('[PageContext] injection failed:', err);
    return {
      ok: false,
      error: 'inject_failed',
      message: 'Unable to access this page. Try reloading the tab.'
    };
  }

  const cfg = { ...DEFAULT_SETTINGS, ...(settings || {}) };

  let response;
  try {
    response = await sendMessageToTab(tab.id, { type: EXTRACT, settings: cfg });
  } catch (err) {
    console.error('[PageContext] messaging failed:', err);
    return {
      ok: false,
      error: 'no_response',
      message: 'The page did not respond. Try reloading and extracting again.'
    };
  }

  if (response && response.ok) {
    await storeLastExtraction(response.result, cfg.defaultFormat);
  }
  return response || { ok: false, error: 'no_response', message: 'No response from page.' };
}

/** Query the active tab in the current window. */
function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

/** Look up a tab by id (used when the request targets a specific page). */
function getTabById(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab || null);
    });
  });
}

/**
 * Inject the bundled content script if it is not already present.
 * Pings first; injects only on failure to avoid duplicate listeners.
 */
async function ensureContentScript(tabId) {
  const alreadyThere = await pingTab(tabId);
  if (alreadyThere) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_BUNDLE]
  });
}

/** Return true if the content script answers a ping. */
async function pingTab(tabId) {
  try {
    const res = await sendMessageToTab(tabId, { type: PING });
    return Boolean(res && res.ready);
  } catch {
    return false;
  }
}

/** Promise wrapper around chrome.tabs.sendMessage with lastError handling. */
function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

/** Persist only the most recent extraction (never an unbounded history). */
async function storeLastExtraction(result, format) {
  const payload = {
    result,
    format,
    storedAt: new Date().toISOString()
  };
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_EXTRACTION]: payload });
  } catch (err) {
    console.warn('[PageContext] could not persist extraction:', err);
  }
}
