/**
 * Options page controller. Loads/saves user settings to chrome.storage.local.
 * Keeps storage interaction isolated from extraction logic.
 */

import { DEFAULT_SETTINGS, STORAGE_KEYS, MAX_CONTENT_LENGTH } from '../utils/constants.js';

const CHECKBOXES = [
  'removeNavigation',
  'removeAdvertisements',
  'removeFooter',
  'removeSidebars',
  'includeLinks',
  'includeImages',
  'includeMetadata'
];

const statusEl = document.getElementById('status');

init();

async function init() {
  const settings = await loadSettings();
  applyToForm(settings);

  document.getElementById('save').addEventListener('click', onSave);
  document.getElementById('reset').addEventListener('click', onReset);
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.SETTINGS, (data) => {
      resolve({ ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) });
    });
  });
}

function applyToForm(settings) {
  for (const key of CHECKBOXES) {
    const box = document.getElementById(key);
    if (box) box.checked = Boolean(settings[key]);
  }
  document.getElementById('defaultFormat').value = settings.defaultFormat;
  document.getElementById('maxContentLength').value = settings.maxContentLength;
  document.getElementById('waitForPageMs').value = settings.waitForPageMs;
}

function readForm() {
  const settings = {};
  for (const key of CHECKBOXES) {
    const box = document.getElementById(key);
    settings[key] = box ? box.checked : DEFAULT_SETTINGS[key];
  }
  settings.defaultFormat = document.getElementById('defaultFormat').value;

  const maxLen = parseInt(document.getElementById('maxContentLength').value, 10);
  settings.maxContentLength = Number.isFinite(maxLen) && maxLen >= 1000 ? maxLen : MAX_CONTENT_LENGTH;

  let wait = parseInt(document.getElementById('waitForPageMs').value, 10);
  if (!Number.isFinite(wait)) wait = 0;
  settings.waitForPageMs = Math.min(Math.max(wait, 0), 1000);

  return settings;
}

async function onSave() {
  const settings = readForm();
  await new Promise((resolve) =>
    chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings }, resolve)
  );
  applyToForm(settings); // reflect any clamped values
  showStatus('✓ Settings saved');
}

async function onReset() {
  await new Promise((resolve) =>
    chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS } }, resolve)
  );
  applyToForm(DEFAULT_SETTINGS);
  showStatus('✓ Reset to defaults');
}

function showStatus(text) {
  statusEl.textContent = text;
  setTimeout(() => {
    statusEl.textContent = '';
  }, 2000);
}
