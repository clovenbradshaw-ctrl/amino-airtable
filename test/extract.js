/**
 * Extract testable functions from index.html
 *
 * Reads the monolithic HTML file, extracts the <script> blocks,
 * and evaluates them in a sandboxed Node.js VM context so that
 * pure-logic functions can be called from tests.
 *
 * DOM-dependent functions won't work (they'll throw), but pure
 * data-processing, formatting, and parsing functions will.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'vm';

const HTML_PATH = join(import.meta.dirname, '..', 'index.html');

/**
 * Build a sandbox context with minimal browser-like globals
 * so the script can be evaluated without crashing on startup.
 */
function buildSandbox() {
  // Stub out browser globals that the script references at parse time
  const noop = () => {};
  const noopEl = {
    style: {},
    classList: { add: noop, remove: noop, contains: () => false },
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => noopEl,
    querySelectorAll: () => [],
    getElementById: () => noopEl,
    getElementsByClassName: () => [],
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    appendChild: noop,
    removeChild: noop,
    setAttribute: noop,
    getAttribute: () => null,
    remove: noop,
    contains: () => false,
    closest: () => null,
    focus: noop,
    blur: noop,
    click: noop,
    scrollTo: noop,
    scrollIntoView: noop,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    offsetWidth: 0,
    offsetHeight: 0,
    children: [],
    childNodes: [],
    parentNode: null,
    parentElement: null,
    nextSibling: null,
    previousSibling: null,
    firstChild: null,
    lastChild: null,
  };

  const document = {
    getElementById: () => noopEl,
    querySelector: () => noopEl,
    querySelectorAll: () => [],
    createElement: (tag) => ({ ...noopEl, tagName: tag }),
    createTextNode: () => noopEl,
    body: { ...noopEl, appendChild: noop },
    head: noopEl,
    addEventListener: noop,
    removeEventListener: noop,
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    documentElement: { ...noopEl },
  };

  const localStorage = {
    _store: {},
    getItem(k) { return this._store[k] ?? null; },
    setItem(k, v) { this._store[k] = String(v); },
    removeItem(k) { delete this._store[k]; },
    clear() { this._store = {}; },
  };

  const crypto = {
    getRandomValues(arr) {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    },
    subtle: {
      importKey: noop,
      deriveKey: noop,
      encrypt: noop,
      decrypt: noop,
      exportKey: noop,
    },
  };

  return {
    // Browser globals
    window: {},
    document,
    localStorage,
    crypto,
    navigator: { credentials: null, userAgent: '' },
    location: { href: '', hostname: 'localhost', search: '', hash: '' },
    history: { pushState: noop, replaceState: noop },
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    alert: noop,
    confirm: () => true,
    prompt: () => '',
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    Uint8Array: globalThis.Uint8Array,
    ArrayBuffer: globalThis.ArrayBuffer,
    JSON,
    Object,
    Array,
    Map,
    Set,
    Date,
    RegExp,
    String,
    Number,
    Boolean,
    Math,
    Error,
    TypeError,
    RangeError,
    Promise,
    Symbol,
    Proxy,
    Reflect,
    WeakMap,
    WeakSet,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    indexedDB: {
      open: () => ({
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
      }),
    },
    Blob: globalThis.Blob,
    File: class File {},
    FileReader: class FileReader { readAsText() {} readAsArrayBuffer() {} },
    Image: class Image {},
    PublicKeyCredential: null,
  };
}

/**
 * Extract all <script> block contents from the HTML file.
 */
function extractScriptBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const content = match[1].trim();
    if (content) blocks.push(content);
  }
  return blocks;
}

/**
 * Load and evaluate index.html scripts, returning the sandbox
 * with all global functions available.
 */
export function loadFunctions() {
  const html = readFileSync(HTML_PATH, 'utf-8');
  const scripts = extractScriptBlocks(html);
  const sandbox = buildSandbox();

  // Make window reference itself
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);

  for (const script of scripts) {
    try {
      vm.runInContext(script, context, { filename: 'index.html' });
    } catch (e) {
      // Some scripts may fail due to DOM access during initialization.
      // That's expected — the functions are still defined.
    }
  }

  return sandbox;
}

/**
 * Get a specific function from the evaluated context.
 */
export function getFunction(name) {
  const ctx = loadFunctions();
  if (typeof ctx[name] !== 'function') {
    throw new Error(`Function "${name}" not found in index.html`);
  }
  return ctx[name];
}

/**
 * Get multiple functions at once.
 */
export function getFunctions(...names) {
  const ctx = loadFunctions();
  const result = {};
  for (const name of names) {
    if (typeof ctx[name] !== 'function') {
      throw new Error(`Function "${name}" not found in index.html`);
    }
    result[name] = ctx[name];
  }
  return result;
}
