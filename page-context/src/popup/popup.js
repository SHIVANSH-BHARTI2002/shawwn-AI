/**
 * Popup controller. Pure UI orchestration: it talks to the service worker to
 * request extraction, renders the resulting payload in the selected format, and
 * wires copy/download. No DOM extraction logic lives here.
 */

import { FORMAT, STORAGE_KEYS, DEFAULT_SETTINGS } from '../utils/constants.js';
import { getDomain, slugifyFilename, formatNumber, isRestrictedUrl } from '../utils/helpers.js';
import { renderFormat, extensionFor, mimeFor } from '../lib/format.js';

const REQUEST_EXTRACTION = 'PAGECONTEXT_REQUEST_EXTRACTION';

const el = {
  title: document.getElementById('page-title'),
  domain: document.getElementById('page-domain'),
  extractBtn: document.getElementById('extract-btn'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  wordCount: document.getElementById('word-count'),
  charCount: document.getElementById('char-count'),
  format: document.getElementById('format-select'),
  output: document.getElementById('output'),
  copyBtn: document.getElementById('copy-btn'),
  downloadBtn: document.getElementById('download-btn'),
  optionsBtn: document.getElementById('open-options')
};

/** In-memory view state for the current popup session. */
const state = {
  result: null,
  settings: { ...DEFAULT_SETTINGS }
};

init();

async function init() {
  state.settings = await loadSettings();
  el.format.value = state.settings.defaultFormat || FORMAT.MARKDOWN;

  await showActiveTab();
  await restoreLastExtraction();

  el.extractBtn.addEventListener('click', onExtract);
  el.format.addEventListener('change', onFormatChange);
  el.copyBtn.addEventListener('click', onCopy);
  el.downloadBtn.addEventListener('click', onDownload);
  el.optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

/** Load persisted settings merged over defaults. */
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.SETTINGS, (data) => {
      resolve({ ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) });
    });
  });
}

/** Display the active tab's title and domain in the header area. */
async function showActiveTab() {
  const tab = await getActiveTab();
  if (!tab) {
    el.title.textContent = 'No active tab';
    el.domain.textContent = '';
    el.extractBtn.disabled = true;
    return;
  }
  el.title.textContent = tab.title || tab.url || 'Untitled page';
  el.domain.textContent = getDomain(tab.url || '');

  if (isRestrictedUrl(tab.url)) {
    el.extractBtn.disabled = true;
    setStatus('This page cannot be accessed by browser extensions.', 'error');
  }
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

/** Restore the last extraction if it matches the current tab's page. */
async function restoreLastExtraction() {
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.LAST_EXTRACTION, (data) =>
      resolve(data[STORAGE_KEYS.LAST_EXTRACTION] || null)
    );
  });
  if (!stored || !stored.result) return;

  const tab = await getActiveTab();
  const samePage = tab && stored.result.page && stored.result.page.url === tab.url;
  if (!samePage) return;

  state.result = stored.result;
  if (stored.format) el.format.value = stored.format;
  renderResult();
  setStatus('✓ Restored last extraction', 'success');
}

async function onExtract() {
  setLoading(true);
  setStatus('Extracting…', 'loading');
  try {
    const response = await sendToWorker({ type: REQUEST_EXTRACTION, settings: state.settings });
    if (response && response.ok) {
      state.result = response.result;
      renderResult();
      setStatus('✓ Page extracted', 'success');
    } else {
      const msg = (response && response.message) || 'Unable to extract this page.';
      setStatus(msg, 'error');
    }
  } catch (err) {
    console.error('[PageContext] popup extract error:', err);
    setStatus('Unable to extract this page.', 'error');
  } finally {
    setLoading(false);
  }
}

function sendToWorker(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

/** Render the current result into the UI at the selected format. */
function renderResult() {
  if (!state.result) return;
  el.results.hidden = false;

  const { wordCount, characterCount } = state.result.content;
  el.wordCount.textContent = `${formatNumber(wordCount)} words`;
  el.charCount.textContent = `${formatNumber(characterCount)} characters`;

  el.output.value = renderFormat(state.result, el.format.value);

  if (state.result.metadata && state.result.metadata.truncated) {
    setStatus(
      `Content truncated at ${formatNumber(state.result.metadata.maxContentLength)} characters.`,
      'loading'
    );
  }
}

function onFormatChange() {
  if (state.result) {
    el.output.value = renderFormat(state.result, el.format.value);
  }
}

async function onCopy() {
  const text = el.output.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    flashButton(el.copyBtn, '✓ Copied');
  } catch (err) {
    // Fallback for environments where the async clipboard API is blocked.
    try {
      el.output.select();
      document.execCommand('copy');
      flashButton(el.copyBtn, '✓ Copied');
    } catch {
      console.error('[PageContext] copy failed:', err);
      setStatus('Copy failed. Select the text manually.', 'error');
    }
  }
}

function onDownload() {
  if (!state.result) return;
  const format = el.format.value;
  const text = renderFormat(state.result, format);
  const name = slugifyFilename(state.result.page.title);
  const filename = `${name}.${extensionFor(format)}`;

  try {
    const blob = new Blob([text], { type: mimeFor(format) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flashButton(el.downloadBtn, '✓ Saved');
  } catch (err) {
    console.error('[PageContext] download failed:', err);
    setStatus('Download failed.', 'error');
  }
}

/* ---- small UI helpers ---- */

function setLoading(loading) {
  el.extractBtn.disabled = loading;
  el.extractBtn.textContent = loading ? 'Extracting…' : 'Extract Page';
}

function setStatus(text, kind) {
  el.status.textContent = text || '';
  el.status.className = `status${kind ? ' ' + kind : ''}`;
}

function flashButton(button, label) {
  const original = button.textContent;
  button.textContent = label;
  button.classList.add('done');
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove('done');
  }, 1500);
}
