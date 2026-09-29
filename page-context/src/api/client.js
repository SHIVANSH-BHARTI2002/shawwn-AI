/**
 * Centralized shawwn backend API client.
 *
 * All backend fetch() calls live here so UI code never scatters network logic.
 * The base URL and optional API token are configurable (options page /
 * shawwn settings). Errors are normalized into { ok, code, message }.
 */

import { STORAGE_KEYS, DEFAULT_SHAWWN_SETTINGS } from '../utils/constants.js';

/** Load shawwn settings (backend URL + token) merged over defaults. */
export function loadShawwnSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.SHAWWN_SETTINGS, (data) => {
      resolve({ ...DEFAULT_SHAWWN_SETTINGS, ...(data[STORAGE_KEYS.SHAWWN_SETTINGS] || {}) });
    });
  });
}

export function saveShawwnSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      { [STORAGE_KEYS.SHAWWN_SETTINGS]: { ...DEFAULT_SHAWWN_SETTINGS, ...settings } },
      resolve
    );
  });
}

/**
 * Content hash matching the backend algorithm exactly:
 *   sha256(title + "\0" + text + "\0" + markdown)  (hex)
 * Lets the extension ask /documents/check whether a page is already indexed.
 */
export async function computeContentHash(result) {
  const page = result.page || {};
  const content = result.content || {};
  const parts = `${page.title || ''}\u0000${content.text || ''}\u0000${content.markdown || ''}`;
  const bytes = new TextEncoder().encode(parts);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class ApiClient {
  constructor(settings) {
    this.baseUrl = (settings.backendUrl || '').replace(/\/+$/, '');
    this.token = settings.apiToken || '';
  }

  _headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return headers;
  }

  async _request(method, path, body) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this._headers(),
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      // Network / backend unreachable.
      return {
        ok: false,
        code: 'BACKEND_UNREACHABLE',
        message: 'Cannot reach the shawwn backend. Is it running?'
      };
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const err = (data && data.error) || {};
      return {
        ok: false,
        code: err.code || `HTTP_${response.status}`,
        message: err.message || `Request failed (${response.status}).`
      };
    }
    return { ok: true, data };
  }

  health() {
    return this._request('GET', '/health');
  }

  checkDocument(url, contentHash) {
    const q = new URLSearchParams({ url, content_hash: contentHash });
    return this._request('GET', `/api/v1/documents/check?${q.toString()}`);
  }

  indexDocument(pageResult) {
    return this._request('POST', '/api/v1/documents', pageResult);
  }

  getDocument(documentId) {
    return this._request('GET', `/api/v1/documents/${documentId}`);
  }

  deleteDocument(documentId) {
    return this._request('DELETE', `/api/v1/documents/${documentId}`);
  }

  sendChatMessage(documentId, message, conversationId, attachments) {
    return this._request('POST', '/api/v1/chat', {
      document_id: documentId,
      message,
      conversation_id: conversationId || undefined,
      attachments: attachments && attachments.length ? attachments : undefined
    });
  }

  getConversation(conversationId) {
    return this._request('GET', `/api/v1/conversations/${conversationId}`);
  }

  deleteConversation(conversationId) {
    return this._request('DELETE', `/api/v1/conversations/${conversationId}`);
  }
}

/** Build an API client from stored settings. */
export async function createApiClient() {
  const settings = await loadShawwnSettings();
  return new ApiClient(settings);
}

export { ApiClient };
