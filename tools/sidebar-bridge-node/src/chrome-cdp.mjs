import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BROWSER_URL = 'http://127.0.0.1:9222';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_CAPTURED_EVENTS = 40;

export async function runChromeCdpCheck(input = {}, options = {}) {
  const browserUrl = normalizeBrowserUrl(input.browser_url || input.browserUrl || options.browserUrl || DEFAULT_BROWSER_URL);
  const timeoutMs = safeInteger(input.timeout_ms ?? input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const artifactRoot = path.resolve(options.artifactRoot || path.join(process.cwd(), 'runs', 'browser-evidence'));
  const target = await resolveChromeTarget(input, { browserUrl, fetchImpl });
  const session = await ChromeCdpSession.connect(target.webSocketDebuggerUrl, {
    WebSocketImpl: options.WebSocketImpl || globalThis.WebSocket,
    timeoutMs,
  });

  const consoleEvents = [];
  const networkEvents = [];
  session.on('Runtime.consoleAPICalled', (event) => {
    consoleEvents.push(compactConsoleEvent(event));
    if (consoleEvents.length > MAX_CAPTURED_EVENTS) consoleEvents.shift();
  });
  session.on('Network.responseReceived', (event) => {
    networkEvents.push(compactNetworkEvent(event));
    if (networkEvents.length > MAX_CAPTURED_EVENTS) networkEvents.shift();
  });

  try {
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    if (input.capture_network || input.captureNetwork) await session.send('Network.enable');

    const viewport = normalizeViewport(input.viewport);
    if (viewport) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.device_scale_factor,
        mobile: viewport.mobile,
      });
    }

    const geolocation = normalizeGeolocation(input.geolocation);
    if (geolocation) {
      await session.send('Emulation.setGeolocationOverride', geolocation);
    }

    const navigateUrl = normalizeOptionalUrl(input.navigate_url || input.navigateUrl);
    if (navigateUrl) {
      const loadPromise = session.waitForEvent('Page.loadEventFired', timeoutMs).catch(() => null);
      await session.send('Page.navigate', { url: navigateUrl });
      await loadPromise;
    }

    const assertion = await runDomAssertion(session, input);
    const screenshot = await maybeCaptureScreenshot(session, {
      artifactRoot,
      enabled: Boolean(input.screenshot),
      format: input.screenshot_format || input.screenshotFormat || 'png',
      label: input.screenshot_label || input.screenshotLabel || assertion?.selector || target.title || 'chrome-cdp-check',
    });

    return {
      ok: assertion ? assertion.ok : true,
      browser_url: browserUrl,
      target: compactTarget(target),
      viewport,
      geolocation,
      assertion,
      screenshot,
      console_events: consoleEvents,
      network_events: networkEvents,
    };
  } finally {
    session.close();
  }
}

export async function listChromeTargets(options = {}) {
  const browserUrl = normalizeBrowserUrl(options.browserUrl || options.browser_url || DEFAULT_BROWSER_URL);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation is available for Chrome target discovery.');
  const response = await fetchImpl(new URL('/json/list', browserUrl).toString());
  if (!response.ok) throw new Error(`Chrome target discovery failed with HTTP ${response.status}.`);
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

export async function resolveChromeTarget(input = {}, options = {}) {
  const targets = Array.isArray(input.targets)
    ? input.targets
    : await listChromeTargets({ browserUrl: options.browserUrl, fetchImpl: options.fetchImpl });
  const selected = selectChromeTarget(targets, input);
  if (!selected?.webSocketDebuggerUrl) {
    throw new Error('No matching Chrome page target with webSocketDebuggerUrl was found.');
  }
  return selected;
}

export function selectChromeTarget(targets = [], input = {}) {
  const targetId = String(input.target_id || input.targetId || '').trim();
  const urlContains = String(input.url_contains || input.urlContains || '').trim();
  const titleContains = String(input.title_contains || input.titleContains || '').trim();
  const pageTargets = (Array.isArray(targets) ? targets : [])
    .filter((target) => target && target.type !== 'browser')
    .filter((target) => !target.type || target.type === 'page');

  if (targetId) {
    return pageTargets.find((target) => target.id === targetId) || null;
  }
  if (urlContains) {
    return pageTargets.find((target) => String(target.url || '').includes(urlContains)) || null;
  }
  if (titleContains) {
    return pageTargets.find((target) => String(target.title || '').includes(titleContains)) || null;
  }
  return pageTargets.find((target) => target.webSocketDebuggerUrl) || null;
}

export class ChromeCdpSession {
  constructor(socket, options = {}) {
    this.socket = socket;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    this.socket.onmessage = (event) => this.handleMessage(event?.data);
    this.socket.onerror = () => this.rejectAll(new Error('Chrome CDP WebSocket error.'));
    this.socket.onclose = () => this.rejectAll(new Error('Chrome CDP WebSocket closed.'));
  }

  static async connect(webSocketUrl, options = {}) {
    const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    if (typeof WebSocketImpl !== 'function') throw new Error('No WebSocket implementation is available.');
    const socket = new WebSocketImpl(webSocketUrl);
    await waitForOpen(socket, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    return new ChromeCdpSession(socket, options);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome CDP command timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify(message));
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }

  waitForEvent(method, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Chrome CDP event timed out: ${method}`));
      }, timeoutMs);
      const handler = (params) => {
        cleanup();
        resolve(params);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.get(method)?.delete(handler);
      };
      this.on(method, handler);
    });
  }

  close() {
    try {
      this.socket.close?.();
    } catch {
      // Closing is best effort after the evidence has already been collected.
    }
  }

  handleMessage(rawMessage) {
    let message;
    try {
      message = JSON.parse(String(rawMessage || '{}'));
    } catch {
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || `Chrome CDP command failed: ${pending.method}`));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    if (message.method && this.listeners.has(message.method)) {
      for (const handler of this.listeners.get(message.method)) handler(message.params || {});
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function runDomAssertion(session, input = {}) {
  const selector = String(input.selector || '').trim();
  const expression = String(input.expression || '').trim();

  if (selector) {
    const result = await session.send('Runtime.evaluate', {
      expression: selectorAssertionExpression(selector),
      returnByValue: true,
      awaitPromise: true,
    });
    const value = result.result?.value || {};
    return {
      ok: Boolean(value.exists && (!input.expect_visible && !input.expectVisible || value.visible)),
      selector,
      exists: Boolean(value.exists),
      visible: Boolean(value.visible),
      text: String(value.text || '').slice(0, 1500),
      rect: value.rect || null,
      layout: value.layout || null,
      clickables: Array.isArray(value.clickables) ? value.clickables.slice(0, 30) : [],
      images: Array.isArray(value.images) ? value.images.slice(0, 30) : [],
    };
  }

  if (expression) {
    const result = await session.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const value = result.result?.value;
    return {
      ok: Boolean(value),
      expression,
      value,
    };
  }

  return null;
}

async function maybeCaptureScreenshot(session, options = {}) {
  if (!options.enabled) return null;
  await mkdir(options.artifactRoot, { recursive: true });
  const format = ['jpeg', 'png', 'webp'].includes(String(options.format).toLowerCase())
    ? String(options.format).toLowerCase()
    : 'png';
  const result = await session.send('Page.captureScreenshot', {
    format,
    captureBeyondViewport: true,
    fromSurface: true,
  });
  const data = String(result.data || '');
  if (!data) return null;
  const filename = `${safeSlug(options.label || 'chrome-cdp-check')}-${Date.now()}.${format === 'jpeg' ? 'jpg' : format}`;
  const filePath = path.join(options.artifactRoot, filename);
  await writeFile(filePath, Buffer.from(data, 'base64'));
  return {
    path: filePath,
    format,
    bytes: Buffer.byteLength(data, 'base64'),
  };
}

function selectorAssertionExpression(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const doc = document.documentElement;
    const body = document.body;
    const viewportWidth = window.innerWidth || doc.clientWidth || 0;
    const viewportHeight = window.innerHeight || doc.clientHeight || 0;
    const documentWidth = Math.max(doc.scrollWidth || 0, body?.scrollWidth || 0, doc.offsetWidth || 0, body?.offsetWidth || 0);
    const documentHeight = Math.max(doc.scrollHeight || 0, body?.scrollHeight || 0, doc.offsetHeight || 0, body?.offsetHeight || 0);
    const layout = {
      viewport_width: viewportWidth,
      viewport_height: viewportHeight,
      document_width: documentWidth,
      document_height: documentHeight,
      horizontal_overflow: Boolean(viewportWidth && documentWidth > viewportWidth + 2)
    };
    const compactRect = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const visibleElement = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return Boolean(rect.width && rect.height && style.visibility !== 'hidden' && style.display !== 'none');
    };
    const clickables = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"]'))
      .filter(visibleElement)
      .slice(0, 30)
      .map((node) => ({
        text: (node.innerText || node.value || node.getAttribute('aria-label') || node.getAttribute('title') || '').trim().slice(0, 160)
      }));
    const images = Array.from(document.images || [])
      .filter(visibleElement)
      .slice(0, 30)
      .map((node) => ({
        alt: (node.alt || '').trim().slice(0, 160),
        box: compactRect(node)
      }));
    if (!el) return { exists: false, visible: false, text: '', rect: null, layout, clickables, images };
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = Boolean(rect.width && rect.height && style.visibility !== 'hidden' && style.display !== 'none');
    return {
      exists: true,
      visible,
      text: (el.innerText || el.textContent || '').trim(),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      layout,
      clickables,
      images
    };
  })()`;
}

function waitForOpen(socket, timeoutMs) {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome CDP WebSocket open timed out.')), timeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Chrome CDP WebSocket connection failed.'));
    };
  });
}

function normalizeBrowserUrl(rawUrl) {
  const value = String(rawUrl || DEFAULT_BROWSER_URL).trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  const url = new URL(withProtocol);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported Chrome browser URL protocol: ${url.protocol}`);
  return url.toString().replace(/\/+$/, '/');
}

function normalizeOptionalUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  return url.toString();
}

function normalizeViewport(value) {
  if (!isPlainObject(value)) return null;
  const width = safeInteger(value.width, 0, 1, 10000);
  const height = safeInteger(value.height, 0, 1, 10000);
  if (!width || !height) return null;
  return {
    width,
    height,
    device_scale_factor: Number(value.device_scale_factor ?? value.deviceScaleFactor ?? 1) || 1,
    mobile: Boolean(value.mobile),
  };
}

function normalizeGeolocation(value) {
  if (!isPlainObject(value)) return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude,
    longitude,
    accuracy: Number(value.accuracy || 100),
  };
}

function compactTarget(target = {}) {
  return {
    id: target.id || '',
    type: target.type || '',
    title: target.title || '',
    url: target.url || '',
  };
}

function compactConsoleEvent(event = {}) {
  return {
    type: event.type || '',
    text: Array.isArray(event.args)
      ? event.args.map((arg) => String(arg.value ?? arg.description ?? '')).filter(Boolean).join(' ')
      : '',
  };
}

function compactNetworkEvent(event = {}) {
  return {
    status: event.response?.status || 0,
    url: event.response?.url || '',
    mime_type: event.response?.mimeType || '',
  };
}

function safeSlug(value) {
  return String(value || 'chrome-cdp-check')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'chrome-cdp-check';
}

function safeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
