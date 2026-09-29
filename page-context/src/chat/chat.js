/**
 * shawwn chat controller.
 *
 * Flow: check backend -> extract current page (reusing the existing
 * service-worker extraction) -> compute content hash -> check/index document ->
 * enable chat -> send questions -> render grounded answers + citations.
 *
 * Extraction reuses the existing PageContext pipeline; no extraction logic is
 * duplicated here.
 */

import { DEFAULT_SETTINGS } from '../utils/constants.js';
import { isRestrictedUrl } from '../utils/helpers.js';
import { createApiClient, computeContentHash } from '../api/client.js';

const REQUEST_EXTRACTION = 'PAGECONTEXT_REQUEST_EXTRACTION';
const REQUEST_HIGHLIGHT = 'PAGECONTEXT_REQUEST_HIGHLIGHT';

const el = {
  title: document.getElementById('page-title'),
  statusPill: document.getElementById('status-pill'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  analyzeRow: document.getElementById('analyze-row'),
  analyzeBtn: document.getElementById('analyze-btn'),
  messages: document.getElementById('messages'),
  suggestions: document.getElementById('suggestions'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  sendBtn: document.getElementById('send-btn'),
  optionsBtn: document.getElementById('open-options')
};

const state = {
  api: null,
  tab: null, // { id, url, title } of the ORIGIN page (passed by the popup)
  documentId: null,
  conversationId: null,
  extraction: null,
  pending: false
};

init();

async function init() {
  state.api = await createApiClient();
  el.optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  el.analyzeBtn.addEventListener('click', analyzePage);
  el.composer.addEventListener('submit', onSubmit);
  el.input.addEventListener('keydown', onKeydown);
  el.input.addEventListener('input', autoGrow);

  state.tab = readOriginTab();
  el.title.textContent = state.tab ? state.tab.title || state.tab.url : 'No active tab';

  if (!state.tab || !state.tab.id || isRestrictedUrl(state.tab.url)) {
    setStatus('error', 'Restricted page');
    el.analyzeBtn.disabled = true;
    addMessage('assistant', 'This page cannot be accessed by browser extensions.', { error: true });
    return;
  }

  await checkBackendAndDocument();
}

/** The origin page tab is passed by the popup via URL query params. */
function readOriginTab() {
  const params = new URLSearchParams(location.search);
  const tabId = params.get('tabId');
  if (!tabId) return null;
  return {
    id: Number(tabId),
    url: params.get('url') || '',
    title: params.get('title') || ''
  };
}

/* ------------------------------------------------------------------ *
 * Backend / indexing
 * ------------------------------------------------------------------ */

async function checkBackendAndDocument() {
  setStatus('busy', 'Checking backend…');
  const health = await state.api.health();
  if (!health.ok) {
    setStatus('error', 'Backend offline');
    addMessage(
      'assistant',
      'The shawwn backend is not reachable. Start it, or set the backend URL in Settings.',
      { error: true }
    );
    return;
  }

  // Extract silently to compute a content hash and check the index.
  setStatus('busy', 'Reading page…');
  const extraction = await extractPage();
  if (!extraction) {
    setStatus('error', 'Cannot read page');
    el.analyzeRow.hidden = false;
    return;
  }
  state.extraction = extraction;

  const hash = await computeContentHash(extraction);
  const check = await state.api.checkDocument(extraction.page.url, hash);
  if (check.ok && check.data.exists && check.data.status === 'indexed') {
    state.documentId = check.data.document_id;
    onIndexed(true);
  } else {
    // Needs indexing: show the Analyze button.
    setStatus('busy', 'Not indexed');
    el.analyzeRow.hidden = false;
  }
}

async function analyzePage() {
  el.analyzeBtn.disabled = true;
  setStatus('busy', 'Analyzing this page…');
  try {
    if (!state.extraction) {
      state.extraction = await extractPage();
    }
    if (!state.extraction) {
      setStatus('error', 'Cannot read page');
      el.analyzeBtn.disabled = false;
      return;
    }
    const res = await state.api.indexDocument(state.extraction);
    if (!res.ok) {
      setStatus('error', 'Indexing failed');
      addMessage('assistant', res.message || 'Failed to index this page.', { error: true });
      el.analyzeBtn.disabled = false;
      return;
    }
    state.documentId = res.data.document_id;
    onIndexed(false);
  } catch (err) {
    console.error('[shawwn] analyze failed:', err);
    setStatus('error', 'Error');
    el.analyzeBtn.disabled = false;
  }
}

function onIndexed(reused) {
  setStatus('ready', reused ? 'Page indexed' : 'Page ready');
  el.analyzeRow.hidden = true;
  el.composer.hidden = false;
  renderSuggestions();
  el.input.focus();
}

/** Reuse the existing service-worker extraction pipeline on the origin tab. */
async function extractPage() {
  try {
    const response = await sendToWorker({
      type: REQUEST_EXTRACTION,
      tabId: state.tab.id,
      settings: { ...DEFAULT_SETTINGS }
    });
    if (response && response.ok) return response.result;
    return null;
  } catch (err) {
    console.error('[shawwn] extraction failed:', err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

async function onSubmit(event) {
  event.preventDefault();
  const text = el.input.value.trim();
  if (!text || state.pending || !state.documentId) return;

  el.input.value = '';
  autoGrow();
  el.suggestions.hidden = true;
  addMessage('user', text);
  setPending(true);

  const typing = addTyping();
  const res = await state.api.sendChatMessage(state.documentId, text, state.conversationId);
  typing.remove();

  if (!res.ok) {
    addMessage('assistant', res.message || 'Something went wrong.', { error: true });
    setPending(false);
    return;
  }

  const data = res.data;
  state.conversationId = data.conversation_id;
  addMessage('assistant', data.answer, { citations: data.citations || [] });
  setPending(false);
}

function onKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    el.composer.requestSubmit();
  }
}

/* ------------------------------------------------------------------ *
 * Suggestions (derived from page structure — no LLM call)
 * ------------------------------------------------------------------ */

function renderSuggestions() {
  const base = [
    'What is this page about?',
    'Summarize this page',
    'What are the key points?'
  ];
  const structure = state.extraction && state.extraction.structure;
  if (structure && structure.tables && structure.tables.length) {
    base.push('What are the important specifications?');
  }
  if (structure && structure.lists && structure.lists.length) {
    base.push('List the main items mentioned');
  }

  el.suggestions.innerHTML = '';
  for (const q of base.slice(0, 5)) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = q;
    chip.addEventListener('click', () => {
      el.input.value = q;
      el.composer.requestSubmit();
    });
    el.suggestions.appendChild(chip);
  }
  el.suggestions.hidden = false;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function addMessage(role, text, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}${opts.error ? ' error' : ''}`;

  const label = document.createElement('div');
  label.className = 'role';
  label.textContent = role === 'user' ? 'You' : 'shawwn';
  wrap.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);

  if (opts.citations && opts.citations.length) {
    wrap.appendChild(renderCitations(opts.citations));
  }

  el.messages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function renderCitations(citations) {
  const box = document.createElement('div');
  box.className = 'sources';

  const title = document.createElement('div');
  title.className = 'sources-title';
  title.textContent = 'Sources';
  box.appendChild(title);

  for (const c of citations) {
    const card = document.createElement('div');
    card.className = 'source-card';

    const sec = document.createElement('div');
    sec.className = 'sec';
    sec.textContent = c.section || (c.heading_path || []).join(' › ') || c.title || 'Source';
    card.appendChild(sec);

    const snippet = document.createElement('div');
    snippet.className = 'snippet';
    snippet.textContent = c.text || '';
    card.appendChild(snippet);

    const btn = document.createElement('button');
    btn.className = 'view-src';
    btn.textContent = 'View on page';
    btn.addEventListener('click', () => viewSource(c));
    card.appendChild(btn);

    box.appendChild(card);
  }
  return box;
}

function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML =
    '<div class="role">shawwn</div><div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>';
  el.messages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

/* ------------------------------------------------------------------ *
 * View source: navigate + highlight on the page
 * ------------------------------------------------------------------ */

async function viewSource(citation) {
  if (!state.tab || !state.tab.id) return;
  try {
    await chrome.tabs.update(state.tab.id, { active: true });
    if (state.tab.windowId != null) {
      await chrome.windows.update(state.tab.windowId, { focused: true });
    }
    await sendToWorker({
      type: REQUEST_HIGHLIGHT,
      tabId: state.tab.id,
      section: citation.section || '',
      headingPath: citation.heading_path || [],
      text: citation.text || ''
    });
  } catch (err) {
    console.error('[shawwn] view source failed:', err);
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

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

function setStatus(kind, text) {
  el.statusPill.className = `status-pill ${kind}`;
  el.statusText.textContent = text;
}

function setPending(pending) {
  state.pending = pending;
  el.sendBtn.disabled = pending;
  el.input.disabled = pending;
  if (!pending) el.input.focus();
}

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 120) + 'px';
}

function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}
