/**
 * shawwn floating widget.
 *
 * Injected on every page (see manifest content_scripts). Renders a floating
 * sheep button; clicking it extracts the current page, indexes it via the
 * backend, and opens an in-page floating chat panel (no separate window).
 *
 * All UI lives inside a Shadow DOM so the host page's CSS never leaks in and
 * our styles never leak out. All backend calls are proxied through the service
 * worker (extension origin) so we don't hit page-origin CORS / host-permission
 * limits. Extraction reuses the existing extractor pipeline directly.
 */

import { extractPage } from '../lib/extractor.js';
import { DEFAULT_SETTINGS, RESTRICTED_URL_PREFIXES } from '../utils/constants.js';

const BACKEND = 'PAGECONTEXT_BACKEND'; // service-worker proxy message type

function initWidget() {
  try {
    bootstrap();
  } catch (err) {
    console.error('[shawwn] widget failed to initialize:', err);
  }
}

function isRestricted(url) {
  const lower = (url || '').toLowerCase();
  return RESTRICTED_URL_PREFIXES.some((p) => lower.startsWith(p));
}

const state = {
  documentId: null,
  conversationId: null,
  extraction: null,
  indexed: false,
  pending: false,
  attachments: [] // { name, mime_type, data_b64 }
};

let ui = {};

function bootstrap() {
  const host = document.createElement('div');
  host.id = 'shawwn-widget-root';
  host.style.all = 'initial';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.appendChild(buildStyle());
  shadow.appendChild(buildUI());
  document.documentElement.appendChild(host);

  enableDragAndClick(ui.launcher);
  ui.closeBtn.addEventListener('click', () => setPanelOpen(false));
  ui.form.addEventListener('submit', onSubmit);
  ui.input.addEventListener('keydown', onKeydown);
  ui.input.addEventListener('input', autoGrow);
  ui.attachBtn.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', onFilesChosen);

  restoreLauncherPosition();
  console.log('[shawwn] widget ready');
}

/**
 * Make the floating launcher both clickable and draggable.
 *
 * Uses mouse + touch events (broadly reliable across sites). A gesture that
 * moves less than DRAG_THRESHOLD px is treated as a CLICK (open/close chat);
 * more movement is a DRAG (reposition only). Position is clamped to the
 * viewport and persisted.
 */
function enableDragAndClick(launcher) {
  const DRAG_THRESHOLD = 5; // px
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  function pointFrom(e) {
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: t.clientX, y: t.clientY };
  }

  // When a real drag happens we set this so the trailing `click` is ignored.
  let suppressClickUntil = 0;

  function onDown(e) {
    if (e.type === 'mousedown' && e.button !== 0) return;
    dragging = true;
    moved = false;
    const p = pointFrom(e);
    startX = p.x;
    startY = p.y;
    const rect = launcher.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    // Anchor with left/top so we can move it freely.
    launcher.style.left = `${originLeft}px`;
    launcher.style.top = `${originTop}px`;
    launcher.style.right = 'auto';
    launcher.style.bottom = 'auto';
    // Listen on window so the drag continues even if the cursor leaves the icon.
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('touchmove', onMove, { capture: true, passive: false });
    window.addEventListener('touchend', onUp, true);
  }

  function onMove(e) {
    if (!dragging) return;
    const p = pointFrom(e);
    const dx = p.x - startX;
    const dy = p.y - startY;
    if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      moved = true;
      launcher.style.cursor = 'grabbing';
    }
    if (moved) {
      if (e.cancelable) e.preventDefault();
      const size = launcher.offsetWidth || 62;
      const left = clamp(originLeft + dx, 4, window.innerWidth - size - 4);
      const top = clamp(originTop + dy, 4, window.innerHeight - size - 4);
      launcher.style.left = `${left}px`;
      launcher.style.top = `${top}px`;
    }
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    launcher.style.cursor = 'pointer';
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('touchmove', onMove, true);
    window.removeEventListener('touchend', onUp, true);
    if (moved) {
      // Was a drag: persist position and suppress the click that follows.
      suppressClickUntil = Date.now() + 300;
      persistLauncherPosition();
    }
  }

  launcher.addEventListener('mousedown', onDown);
  launcher.addEventListener('touchstart', onDown, { passive: true });

  // Primary open trigger: a real click on the button. Buttons reliably fire
  // `click`, so this is the robust path. We only ignore it right after a drag.
  launcher.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (Date.now() < suppressClickUntil) return;
    console.log('[shawwn] launcher clicked');
    togglePanel();
  });
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Keep the panel anchored just above the launcher wherever it is dragged. */
function movePanelNearLauncher(left, top, size) {
  if (!ui.panel) return;
  const panelW = 384;
  const panelH = Math.min(564, window.innerHeight - 128);
  let panelLeft = clamp(left + size - panelW, 8, window.innerWidth - panelW - 8);
  let panelTop = top - panelH - 12;
  if (panelTop < 8) panelTop = clamp(top + size + 12, 8, window.innerHeight - panelH - 8);
  ui.panel.style.left = `${panelLeft}px`;
  ui.panel.style.top = `${panelTop}px`;
  ui.panel.style.right = 'auto';
  ui.panel.style.bottom = 'auto';
}

function persistLauncherPosition() {
  try {
    const rect = ui.launcher.getBoundingClientRect();
    chrome.storage &&
      chrome.storage.local.set({
        'shawwn.launcherPos': { left: rect.left, top: rect.top }
      });
  } catch {}
}

function restoreLauncherPosition() {
  try {
    chrome.storage.local.get('shawwn.launcherPos', (data) => {
      const pos = data && data['shawwn.launcherPos'];
      if (!pos) return;
      const size = ui.launcher.offsetWidth || 62;
      const left = clamp(pos.left, 4, window.innerWidth - size - 4);
      const top = clamp(pos.top, 4, window.innerHeight - size - 4);
      ui.launcher.style.left = `${left}px`;
      ui.launcher.style.top = `${top}px`;
      ui.launcher.style.right = 'auto';
      ui.launcher.style.bottom = 'auto';
      // Panel position is computed fresh on each open (positionPanelSafely).
    });
  } catch {}
}

/* ------------------------------------------------------------------ *
 * UI construction (Shadow DOM)
 * ------------------------------------------------------------------ */

function buildStyle() {
  const style = document.createElement('style');
  // Palette derived from the shawwn sheep logo: sage green, deep green,
  // cream wool, soft pink accent, near-black ink.
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .launcher {
      position: fixed; right: 20px; bottom: 20px; width: 62px; height: 62px;
      border-radius: 50%; border: 3px solid #2f6b54; cursor: pointer; z-index: 2147483647;
      box-shadow: 0 6px 22px rgba(31,74,58,0.4); background: #4a9478; padding: 0; overflow: hidden;
      transition: transform 0.15s ease; touch-action: none; user-select: none;
    }
    .launcher:hover { transform: scale(1.08); }
    .launcher:active { cursor: grabbing; }
    .launcher img { width: 100%; height: 100%; border-radius: 50%; display: block; object-fit: cover; pointer-events: none; -webkit-user-drag: none; }
    .panel {
      position: fixed; right: 20px; bottom: 96px; width: 384px; height: 564px;
      max-height: calc(100vh - 128px); background: #fdfcf7; border-radius: 18px;
      box-shadow: 0 16px 48px rgba(31,74,58,0.35); z-index: 2147483647;
      display: none; flex-direction: column; overflow: hidden; color: #1e1e1e;
      border: 1px solid #dfe7e0;
    }
    .panel.open { display: flex; }
    .head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px; background: #2f6b54; color: #f4f1e8;
    }
    .head .title { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; }
    .head .title img { width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.5); }
    .head .status { font-size: 11px; opacity: 0.9; }
    .icon-btn { border: none; background: transparent; color: #f4f1e8; font-size: 18px; cursor: pointer; line-height: 1; }
    .msgs { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; background: #f4f1e8; }
    .msg { display: flex; flex-direction: column; gap: 3px; }
    .msg .role { font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: #6b7f74; font-weight: 700; }
    .msg .bubble { padding: 9px 12px; border-radius: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; font-size: 14px; }
    .msg.user .bubble { background: #4a9478; color: #fff; align-self: flex-start; }
    .msg.assistant .bubble { background: #fff; border: 1px solid #dfe7e0; }
    .msg.error .bubble { background: #fdeaea; border: 1px solid #e6a5a5; color: #a3403f; }
    .sources { margin-top: 6px; display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
    .sources-label { font-size: 10px; font-weight: 700; color: #6b7f74; text-transform: uppercase; margin-right: 2px; }
    .src-chip {
      width: 20px; height: 20px; border-radius: 50%; border: 1px solid #bcd8c8;
      background: #e6f0ea; color: #2f6b54; font-size: 11px; font-weight: 700;
      cursor: pointer; line-height: 1; padding: 0; display: inline-flex;
      align-items: center; justify-content: center;
    }
    .src-chip:hover { background: #2f6b54; color: #fff; border-color: #2f6b54; }
    /* Markdown formatting inside assistant bubbles */
    .bubble .md-p { margin: 0 0 8px; }
    .bubble .md-p:last-child { margin-bottom: 0; }
    .bubble .md-h { margin: 6px 0 4px; font-size: 14px; font-weight: 700; color: #2f6b54; }
    .bubble .md-list { margin: 4px 0 8px; padding-left: 20px; }
    .bubble .md-list:last-child { margin-bottom: 0; }
    .bubble .md-list li { margin: 2px 0; }
    .bubble code { background: #eef2f0; padding: 1px 4px; border-radius: 4px; font-size: 12px; font-family: "SF Mono", Consolas, monospace; }
    .bubble strong { font-weight: 700; }
    .bubble a { color: #2f6b54; }
    .typing span { display:inline-block; width:6px; height:6px; border-radius:50%; background:#8aa89a; margin-right:3px; animation: b 1.2s infinite; }
    .typing span:nth-child(2){animation-delay:.2s} .typing span:nth-child(3){animation-delay:.4s}
    @keyframes b { 0%,80%,100%{opacity:.2} 40%{opacity:1} }
    .chips { padding: 8px 14px 0; display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { border: 1px solid #cfe0d6; background:#fff; border-radius: 999px; padding: 6px 10px; font-size: 12px; cursor: pointer; color:#2f6b54; }
    .chip:hover { background:#e6f0ea; border-color:#4a9478; }
    .attachments { padding: 6px 14px 0; display:flex; flex-wrap:wrap; gap:6px; }
    .att-chip { font-size: 11px; background:#e6f0ea; border:1px solid #bcd8c8; border-radius:6px; padding:3px 6px; display:flex; align-items:center; gap:5px; color:#2f6b54; }
    .att-chip button { border:none; background:none; cursor:pointer; color:#2f6b54; font-size:12px; }
    .composer { display: flex; align-items: flex-end; gap: 6px; padding: 10px 12px; border-top: 1px solid #dfe7e0; background:#fdfcf7; }
    .composer textarea { flex:1; resize:none; max-height:110px; padding:8px 10px; border:1px solid #cfe0d6; border-radius:10px; font-size:14px; font-family:inherit; outline:none; }
    .composer textarea:focus { border-color:#4a9478; }
    .composer button { border:none; border-radius:10px; background:#4a9478; color:#fff; cursor:pointer; }
    .composer button:hover { background:#3f8168; }
    .attach-btn { width:36px; height:36px; font-size:16px; flex-shrink:0; background:#e6f0ea !important; }
    .send-btn { width:40px; height:36px; font-size:15px; flex-shrink:0; }
    .send-btn:disabled { opacity:.5; cursor:default; }
    .analyze { padding: 16px 14px; }
    .analyze button { width:100%; padding:10px; border:none; border-radius:10px; background:#4a9478; color:#fff; font-weight:600; font-size:14px; cursor:pointer; }
  `;
  return style;
}

function buildUI() {
  const logo = safeLogoUrl();
  const frag = document.createDocumentFragment();

  const launcher = document.createElement('button');
  launcher.className = 'launcher';
  launcher.title = 'Ask shawwn about this page';
  launcher.innerHTML = `<img alt="shawwn" src="${logo}" />`;

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="head">
      <div class="title"><img src="${logo}" alt="" /> shawwn</div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="status" data-status>Starting…</span>
        <button class="icon-btn" data-close title="Close">✕</button>
      </div>
    </div>
    <div class="analyze" data-analyze hidden>
      <button data-analyze-btn>Analyze this page</button>
    </div>
    <div class="msgs" data-msgs></div>
    <div class="chips" data-chips hidden></div>
    <div class="attachments" data-attachments hidden></div>
    <form class="composer" data-form hidden>
      <button type="button" class="attach-btn" data-attach title="Attach image or PDF">📎</button>
      <input type="file" data-file accept="image/*,application/pdf" multiple hidden />
      <textarea data-input rows="1" placeholder="Ask about this page…"></textarea>
      <button type="submit" class="send-btn" data-send title="Send">➤</button>
    </form>
  `;

  frag.appendChild(launcher);
  frag.appendChild(panel);

  ui = {
    launcher,
    panel,
    status: panel.querySelector('[data-status]'),
    closeBtn: panel.querySelector('[data-close]'),
    analyzeRow: panel.querySelector('[data-analyze]'),
    analyzeBtn: panel.querySelector('[data-analyze-btn]'),
    msgs: panel.querySelector('[data-msgs]'),
    chips: panel.querySelector('[data-chips]'),
    attachmentsRow: panel.querySelector('[data-attachments]'),
    form: panel.querySelector('[data-form]'),
    input: panel.querySelector('[data-input]'),
    sendBtn: panel.querySelector('[data-send]'),
    attachBtn: panel.querySelector('[data-attach]'),
    fileInput: panel.querySelector('[data-file]')
  };
  ui.analyzeBtn.addEventListener('click', analyze);
  return frag;
}

function safeLogoUrl() {
  try {
    return chrome.runtime.getURL('assets/icons/shawwn_logo.png');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * Panel open / init flow
 * ------------------------------------------------------------------ */

let started = false;

async function togglePanel() {
  const open = !ui.panel.classList.contains('open');
  setPanelOpen(open);
  if (open && !started) {
    started = true;
    try {
      await startSession();
    } catch (err) {
      console.error('[shawwn] session error:', err);
      setStatus('Error');
      addMsg('assistant', 'Something went wrong starting up. Check that the backend is running, then reopen me.', { error: true });
      started = false; // allow retry on next open
    }
  }
}

function setPanelOpen(open) {
  if (open) {
    positionPanelSafely();
  }
  ui.panel.classList.toggle('open', open);
  if (open) ui.input && ui.input.focus();
}

/**
 * Place the panel fully inside the viewport, anchored near the launcher.
 * Called on every open so the chat is always visible regardless of where the
 * launcher has been dragged.
 */
function positionPanelSafely() {
  const rect = ui.launcher.getBoundingClientRect();
  const size = ui.launcher.offsetWidth || 62;
  const margin = 12;
  const panelW = 384;
  const panelH = Math.min(564, window.innerHeight - 2 * margin);

  // Prefer above the launcher; if not enough room, place below; clamp to view.
  let left = rect.left + size - panelW;
  let top = rect.top - panelH - margin;
  if (top < margin) top = rect.bottom + margin;
  left = clamp(left, margin, Math.max(margin, window.innerWidth - panelW - margin));
  top = clamp(top, margin, Math.max(margin, window.innerHeight - panelH - margin));

  ui.panel.style.position = 'fixed';
  ui.panel.style.left = `${left}px`;
  ui.panel.style.top = `${top}px`;
  ui.panel.style.right = 'auto';
  ui.panel.style.bottom = 'auto';
  ui.panel.style.height = `${panelH}px`;
}

async function startSession() {
  // 1) Always extract the page first (this is what "click -> auto-extract"
  //    means). Extraction is local and does not depend on the backend.
  setStatus('Reading page…');
  const extraction = extractCurrentPage();
  if (!extraction) {
    setStatus('Nothing to read');
    addMsg('assistant', 'There isn\'t much readable content on this page.', { error: true });
    return;
  }
  state.extraction = extraction;
  console.log('[shawwn] extracted page:', extraction.content.wordCount, 'words');

  // 2) Then check the backend so we can index + chat.
  setStatus('Checking backend…');
  const health = await backend('health');
  if (!health.ok) {
    setStatus('Backend offline');
    addMsg(
      'assistant',
      'I\'ve read this page, but I can\'t reach the shawwn backend to answer questions. Start it (or set the URL in the extension settings), then reopen me.',
      { error: true }
    );
    return;
  }

  // 3) Auto-index and enable chat.
  await analyze();
}

async function analyze() {
  ui.analyzeRow.hidden = true;
  ui.analyzeBtn.disabled = true;
  setStatus('Analyzing this page…');
  try {
    if (!state.extraction) state.extraction = extractCurrentPage();
    if (!state.extraction) {
      setStatus('Nothing to read');
      return;
    }
    const res = await backend('indexDocument', { pageResult: state.extraction });
    if (!res.ok) {
      setStatus('Indexing failed');
      addMsg('assistant', res.message || 'I couldn\'t index this page.', { error: true });
      ui.analyzeRow.hidden = false;
      ui.analyzeBtn.disabled = false;
      return;
    }
    state.documentId = res.data.document_id;
    state.indexed = true;
    setStatus('Page ready');
    ui.form.hidden = false;
    renderChips();
    if (!ui.msgs.children.length) {
      addMsg('assistant', 'Hi! I\'ve read this page. Ask me anything about it, or attach an image or PDF and I\'ll take a look.');
    }
    ui.input.focus();
  } catch (err) {
    console.error('[shawwn] analyze error:', err);
    setStatus('Error');
    ui.analyzeRow.hidden = false;
    ui.analyzeBtn.disabled = false;
  }
}

/** Extract using the existing pipeline directly (we run in the page). */
function extractCurrentPage() {
  try {
    const result = extractPage({
      doc: document,
      win: window,
      url: location.href,
      settings: { ...DEFAULT_SETTINGS }
    });
    const has =
      (result.content.text && result.content.text.trim()) ||
      (result.content.markdown && result.content.markdown.trim());
    return has ? result : null;
  } catch (err) {
    console.error('[shawwn] extraction error:', err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Sending messages
 * ------------------------------------------------------------------ */

async function onSubmit(event) {
  event.preventDefault();
  const text = ui.input.value.trim();
  if ((!text && !state.attachments.length) || state.pending || !state.documentId) return;

  const attachments = state.attachments.slice();
  const shownText = text || (attachments.length ? '(sent files)' : '');
  ui.input.value = '';
  autoGrow();
  ui.chips.hidden = true;
  addMsg('user', shownText + (attachments.length ? `  📎 ${attachments.length}` : ''));
  clearAttachments();
  setPending(true);

  const message = text || 'Please look at the attached file(s).';
  const typing = addTyping();

  let res = await sendChat(message, attachments);

  // If the backend lost the document's vectors (e.g. it restarted), re-index
  // this page once and retry automatically.
  if (!res.ok && res.code === 'NEEDS_REINDEX') {
    setStatus('Re-analyzing page…');
    const reindexed = await backend('indexDocument', { pageResult: state.extraction });
    if (reindexed.ok) {
      state.documentId = reindexed.data.document_id;
      setStatus('Page ready');
      res = await sendChat(message, attachments);
    }
  }

  typing.remove();

  if (!res.ok) {
    addMsg('assistant', res.message || 'Something went wrong.', { error: true });
    setPending(false);
    return;
  }
  state.conversationId = res.data.conversation_id;
  addMsg('assistant', res.data.answer, { citations: res.data.citations || [] });
  setPending(false);
}

function sendChat(message, attachments) {
  return backend('sendChatMessage', {
    documentId: state.documentId,
    message,
    conversationId: state.conversationId,
    attachments
  });
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ui.form.requestSubmit();
  }
}

/* ------------------------------------------------------------------ *
 * File attachments
 * ------------------------------------------------------------------ */

async function onFilesChosen() {
  const files = Array.from(ui.fileInput.files || []);
  ui.fileInput.value = '';
  for (const file of files) {
    if (state.attachments.length >= 5) break;
    const okType = file.type.startsWith('image/') || file.type === 'application/pdf';
    if (!okType) {
      addMsg('assistant', `"${file.name}" isn't a supported type (images or PDF only).`, { error: true });
      continue;
    }
    if (file.size > 11 * 1024 * 1024) {
      addMsg('assistant', `"${file.name}" is too large (max ~11 MB).`, { error: true });
      continue;
    }
    const data_b64 = await fileToBase64(file);
    state.attachments.push({ name: file.name, mime_type: file.type, data_b64 });
  }
  renderAttachments();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderAttachments() {
  ui.attachmentsRow.innerHTML = '';
  if (!state.attachments.length) {
    ui.attachmentsRow.hidden = true;
    return;
  }
  ui.attachmentsRow.hidden = false;
  state.attachments.forEach((att, i) => {
    const chip = document.createElement('span');
    chip.className = 'att-chip';
    chip.innerHTML = `📎 ${att.name || att.mime_type} <button title="Remove">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      state.attachments.splice(i, 1);
      renderAttachments();
    });
    ui.attachmentsRow.appendChild(chip);
  });
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

/* ------------------------------------------------------------------ *
 * Suggestions
 * ------------------------------------------------------------------ */

function renderChips() {
  const base = ['What is this page about?', 'Summarize this page', 'What are the key points?'];
  const s = state.extraction && state.extraction.structure;
  if (s && s.tables && s.tables.length) base.push('What are the key specifications?');
  ui.chips.innerHTML = '';
  base.slice(0, 4).forEach((q) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = q;
    chip.addEventListener('click', () => {
      ui.input.value = q;
      ui.form.requestSubmit();
    });
    ui.chips.appendChild(chip);
  });
  ui.chips.hidden = false;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function addMsg(role, text, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}${opts.error ? ' error' : ''}`;
  const label = document.createElement('div');
  label.className = 'role';
  label.textContent = role === 'user' ? 'You' : 'shawwn';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  // Assistant answers are markdown; render them. User text stays plain.
  if (role === 'assistant' && !opts.error) {
    renderMarkdownInto(bubble, text);
  } else {
    bubble.textContent = text;
  }
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  if (opts.citations && opts.citations.length) wrap.appendChild(renderCitations(opts.citations));
  ui.msgs.appendChild(wrap);
  scrollDown();
  return wrap;
}

/**
 * Compact sources: a row of small numbered chips under the answer. Hovering
 * shows the section; clicking highlights that section on the page.
 */
function renderCitations(citations) {
  const box = document.createElement('div');
  box.className = 'sources';

  const label = document.createElement('span');
  label.className = 'sources-label';
  label.textContent = 'Sources:';
  box.appendChild(label);

  citations.forEach((c, i) => {
    const chip = document.createElement('button');
    chip.className = 'src-chip';
    chip.textContent = String(i + 1);
    const section = c.section || (c.heading_path || []).join(' › ') || 'Source';
    chip.title = section + (c.text ? ` — ${c.text.slice(0, 120)}` : '');
    chip.setAttribute('aria-label', `Source ${i + 1}: ${section}`);
    chip.addEventListener('click', () => highlightOnPage(c));
    box.appendChild(chip);
  });
  return box;
}

/* ------------------------------------------------------------------ *
 * Minimal, safe Markdown renderer
 * ------------------------------------------------------------------ *
 * Supports headings, bold, italic, inline code, links, unordered and
 * ordered lists, and paragraphs. Text is escaped before inline formatting
 * is applied, so model output cannot inject HTML.
 */
function renderMarkdownInto(container, md) {
  container.innerHTML = '';
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');

  let i = 0;
  let listEl = null;
  let listType = null;

  const closeList = () => {
    if (listEl) container.appendChild(listEl);
    listEl = null;
    listType = null;
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      i += 1;
      continue;
    }

    // Headings: #, ##, ###
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const el = document.createElement(`h${Math.min(h[1].length + 2, 6)}`);
      el.className = 'md-h';
      el.innerHTML = inlineMd(h[2]);
      container.appendChild(el);
      i += 1;
      continue;
    }

    // Unordered list item: -, *, •
    const ul = trimmed.match(/^[-*•]\s+(.*)$/);
    // Ordered list item: 1. 2) etc.
    const ol = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      const type = ul ? 'ul' : 'ol';
      if (listType !== type) {
        closeList();
        listEl = document.createElement(type);
        listEl.className = 'md-list';
        listType = type;
      }
      const li = document.createElement('li');
      li.innerHTML = inlineMd(ul ? ul[1] : ol[2]);
      listEl.appendChild(li);
      i += 1;
      continue;
    }

    // Paragraph (merge consecutive non-empty, non-special lines)
    closeList();
    const paraLines = [trimmed];
    i += 1;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || /^(#{1,6})\s/.test(t) || /^[-*•]\s/.test(t) || /^\d+[.)]\s/.test(t)) break;
      paraLines.push(t);
      i += 1;
    }
    const p = document.createElement('p');
    p.className = 'md-p';
    p.innerHTML = inlineMd(paraLines.join(' '));
    container.appendChild(p);
  }
  closeList();
}

/** Escape HTML then apply inline markdown (bold, italic, code, links). */
function inlineMd(text) {
  let s = escapeHtml(text);
  // inline code first (protect its contents from other rules)
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // bold **text** or __text__
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // italic *text* or _text_
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = '<div class="role">shawwn</div><div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>';
  ui.msgs.appendChild(wrap);
  scrollDown();
  return wrap;
}

/* ------------------------------------------------------------------ *
 * View source: highlight directly in this page (we're already in it)
 * ------------------------------------------------------------------ */

function highlightOnPage(citation) {
  const section = citation.section || '';
  const path = citation.heading_path || [];
  const text = citation.text || '';
  const target =
    findHeading(section) || findHeading(path[path.length - 1] || '') || findByText(text);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flash(target);
}

function norm(s) { return (s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

function findHeading(sectionText) {
  const wanted = norm(sectionText);
  if (!wanted) return null;
  const hs = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (const h of hs) if (norm(h.textContent) === wanted) return h;
  for (const h of hs) if (norm(h.textContent).includes(wanted)) return h;
  return null;
}

function findByText(text) {
  const snippet = norm(text).slice(0, 40);
  if (!snippet) return null;
  const els = document.querySelectorAll('p,li,td,th,blockquote,pre,span,div');
  for (const el of els) {
    if (el.children.length > 3) continue;
    if (norm(el.textContent).includes(snippet)) return el;
  }
  return null;
}

function flash(el) {
  const prevOutline = el.style.outline;
  const prevBg = el.style.backgroundColor;
  el.style.transition = 'background-color .3s, outline .3s';
  el.style.outline = '3px solid #4a9478';
  el.style.backgroundColor = 'rgba(74,148,120,0.18)';
  setTimeout(() => {
    el.style.outline = prevOutline;
    el.style.backgroundColor = prevBg;
  }, 2500);
}

/* ------------------------------------------------------------------ *
 * Backend proxy + helpers
 * ------------------------------------------------------------------ */

function backend(action, params = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: BACKEND, action, params }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, code: 'PROXY_ERROR', message: 'Extension messaging failed.' });
        return;
      }
      resolve(response || { ok: false, message: 'No response.' });
    });
  });
}

function setStatus(text) { ui.status.textContent = text; }

function setPending(p) {
  state.pending = p;
  ui.sendBtn.disabled = p;
  ui.input.disabled = p;
  if (!p) ui.input.focus();
}

function autoGrow() {
  ui.input.style.height = 'auto';
  ui.input.style.height = Math.min(ui.input.scrollHeight, 110) + 'px';
}

function scrollDown() { ui.msgs.scrollTop = ui.msgs.scrollHeight; }

/* ------------------------------------------------------------------ *
 * Injection trigger (kept at the very end so all module-level
 * declarations — state, ui, constants — are initialized before the
 * widget bootstraps. Running it earlier caused `var ui = {}` to
 * re-initialize AFTER buildUI() populated it, wiping the UI refs.)
 * ------------------------------------------------------------------ */
console.log('[shawwn] widget script loaded on', location.href);
if (!window.__shawwnWidgetInjected && !isRestricted(location.href)) {
  window.__shawwnWidgetInjected = true;
  if (document.body || document.documentElement) {
    initWidget();
  } else {
    document.addEventListener('DOMContentLoaded', initWidget, { once: true });
  }
}
