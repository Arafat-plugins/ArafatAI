#!/usr/bin/env node

import CDP from 'chrome-remote-interface';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 9223;
const RISKY_RE = /(submit|save|delete|remove|publish|post|confirm|continue|checkout|pay|send)/i;

function parseArgs(argv) {
  const options = {
    actions: [],
    port: DEFAULT_PORT,
    waitMs: 500,
    timeout: 15000,
    viewport: '1365x900',
    yes: false,
    headless: false,
    keepOpen: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === '--url') options.url = next();
    else if (arg === '--fixture') options.fixture = next();
    else if (arg === '--click') options.actions.push({ type: 'click', value: next() });
    else if (arg === '--type') options.actions.push({ type: 'type', value: next() });
    else if (arg === '--upload') options.actions.push({ type: 'upload', value: next() });
    else if (arg === '--expect') options.actions.push({ type: 'expect', value: next() });
    else if (arg === '--screenshot') options.actions.push({ type: 'screenshot', value: next() });
    else if (arg === '--snapshot') options.actions.push({ type: 'snapshot', value: next() });
    else if (arg === '--wait') options.actions.push({ type: 'wait', value: Number(next()) });
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--timeout') options.timeout = Number(next());
    else if (arg === '--wait-ms') options.waitMs = Number(next());
    else if (arg === '--viewport') options.viewport = next();
    else if (arg === '--user-data-dir') options.userDataDir = next();
    else if (arg === '--chrome') options.chromePath = next();
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--keep-open') options.keepOpen = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  return `Browser Agent MVP

Usage:
  node src/cli.js --url <url> [actions]

Actions run in order:
  --click <css|text=Label>
  --type <css=value>
  --upload <css=file-path>
  --expect <css|text=Label>
  --screenshot <file-path>
  --snapshot <json-file-path>
  --wait <milliseconds>

Options:
  --fixture click-test
  --viewport 1365x900
  --timeout 15000
  --wait-ms 500
  --headless
  --keep-open
  --yes
  --chrome <chrome-path>
  --user-data-dir <profile-dir>

Example:
  node src/cli.js --url http://user-sites.local/en/add-listing/ --click 'text=Here' --expect '#theme-login-modal.show' --screenshot runs/modal.png --yes
`;
}

function getFixtureUrl(name) {
  const fixtures = {
    'click-test': path.join(ROOT, 'fixtures', 'click-test.html'),
  };
  const filePath = fixtures[name];
  if (!filePath) throw new Error(`Unknown fixture: ${name}`);
  return pathToFileURL(filePath).href;
}

function splitAssignment(value, label) {
  const index = value.lastIndexOf('=');
  if (index <= 0) throw new Error(`${label} must be formatted like selector=value`);
  return {
    selector: value.slice(0, index),
    payload: value.slice(index + 1),
  };
}

function parseViewport(viewport) {
  const match = /^(\d+)x(\d+)$/i.exec(viewport);
  if (!match) throw new Error('--viewport must look like 1365x900');
  return { width: Number(match[1]), height: Number(match[2]) };
}

function findChromePath(explicitPath) {
  if (explicitPath) return explicitPath;

  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('Chrome/Edge not found. Pass --chrome "C:/path/to/chrome.exe".');
  }

  return found;
}

function makeRunDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(ROOT, 'runs', stamp);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function resolveOutputPath(filePath, runDir) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(ROOT, filePath.startsWith('runs/') ? filePath : path.join(runDir, filePath));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function launchChrome(options, runDir) {
  const chromePath = findChromePath(options.chromePath);
  const userDataDir = options.userDataDir
    ? path.resolve(options.userDataDir)
    : path.join(os.tmpdir(), `browser-agent-mvp-profile-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--disable-background-timer-throttling',
    'about:blank',
  ];

  if (options.headless) args.unshift('--headless=new', '--disable-gpu');

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();

  return {
    child,
    chromePath,
    userDataDir,
    shouldCleanupUserDataDir: !options.userDataDir,
  };
}

function selectorExpression(selector) {
  return `
(() => {
  const selector = ${JSON.stringify(selector)};
  const isVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();
  if (selector.startsWith('text=')) {
    const needle = normalize(selector.slice(5)).toLowerCase();
    const textOf = (el) => normalize(el.innerText || el.value || el.getAttribute('aria-label') || el.textContent);
    const score = (el) => {
      const text = textOf(el).toLowerCase();
      const rect = el.getBoundingClientRect();
      const exact = text === needle ? 0 : 1000;
      const interactive = el.matches('a,button,[role="button"],input,textarea,select,label,summary,[contenteditable="true"],[onclick]') ? 0 : 100;
      return exact + interactive + rect.width * rect.height / 100000;
    };
    const primary = [...document.querySelectorAll('a,button,[role="button"],input,textarea,select,label,summary,[contenteditable="true"],[onclick]')]
      .filter((el) => isVisible(el) && textOf(el).toLowerCase().includes(needle))
      .sort((a, b) => score(a) - score(b));
    if (primary[0]) return primary[0];
    return [...document.querySelectorAll('span,div,p,li')]
      .filter((el) => isVisible(el) && textOf(el).toLowerCase().includes(needle))
      .sort((a, b) => score(a) - score(b))[0] || null;
  }
  return document.querySelector(selector);
})()
`;
}

async function evaluate(client, expression, returnByValue = true) {
  const result = await client.Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue,
  });

  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(text);
  }

  return result.result;
}

async function waitForElement(client, selector, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await evaluate(client, `
(() => {
  const el = ${selectorExpression(selector)};
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    tag: el.tagName,
    text: (el.innerText || el.value || el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height
  };
})()
`);

    if (found.value?.visible) return found.value;
    await sleep(250);
  }

  throw new Error(`Element not found or not visible: ${selector}`);
}

async function getClickablePoint(client, selector, timeout) {
  await waitForElement(client, selector, timeout);
  const start = Date.now();
  let lastPoint = null;

  while (Date.now() - start < timeout) {
    const result = await evaluate(client, `
(() => {
  const el = ${selectorExpression(selector)};
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const topEl = document.elementFromPoint(x, y);
  return {
    x,
    y,
    width: rect.width,
    height: rect.height,
    tag: el.tagName,
    text: (el.innerText || el.value || el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    coveredBy: topEl ? topEl.tagName + (topEl.id ? '#' + topEl.id : '') + (topEl.className ? '.' + String(topEl.className).replace(/\\s+/g, '.') : '') : null,
    sameTopElement: topEl === el || el.contains(topEl)
  };
})()
`);

    if (!result.value) throw new Error(`Element disappeared before click: ${selector}`);
    lastPoint = result.value;
    if (lastPoint.sameTopElement) return lastPoint;
    await sleep(250);
  }

  throw new Error(`Element is covered at click point by ${lastPoint?.coveredBy || 'unknown'}: ${selector}`);
}

async function realClick(client, selector, timeout) {
  const point = await getClickablePoint(client, selector, timeout);

  await client.Input.dispatchMouseEvent({
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
  });
  await client.Input.dispatchMouseEvent({
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await client.Input.dispatchMouseEvent({
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });

  return point;
}

async function typeText(client, selector, text, timeout) {
  await realClick(client, selector, timeout);
  await evaluate(client, `
(() => {
  const el = ${selectorExpression(selector)};
  if (!el) return false;
  el.focus();
  if ('value' in el) {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
})()
`);
  await client.Input.insertText({ text });
}

async function uploadFile(client, selector, filePath, timeout) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Upload file does not exist: ${absolutePath}`);

  await waitForElement(client, selector, timeout);
  const documentNode = await client.DOM.getDocument({ depth: -1, pierce: true });
  const query = await client.DOM.querySelector({
    nodeId: documentNode.root.nodeId,
    selector,
  });

  if (!query.nodeId) throw new Error(`File input not found for selector: ${selector}`);

  await client.DOM.setFileInputFiles({
    nodeId: query.nodeId,
    files: [absolutePath],
  });

  return absolutePath;
}

async function takeScreenshot(client, filePath, runDir) {
  const outputPath = resolveOutputPath(filePath, runDir);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const screenshot = await client.Page.captureScreenshot({ format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'));
  return outputPath;
}

async function takeSnapshot(client, filePath, runDir, viewport) {
  const outputPath = resolveOutputPath(filePath, runDir);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const snapshot = await evaluate(client, `
(() => {
  const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const simpleSelector = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const attr = ['name', 'aria-label', 'title', 'type']
      .map((name) => [name, el.getAttribute(name)])
      .find(([, value]) => value);
    if (attr) return el.tagName.toLowerCase() + '[' + attr[0] + '="' + CSS.escape(attr[1]) + '"]';
    const classes = Array.from(el.classList || []).slice(0, 3).map((name) => '.' + CSS.escape(name)).join('');
    return el.tagName.toLowerCase() + classes;
  };
  const box = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  };
  const clickables = Array.from(document.querySelectorAll('a,button,input,textarea,select,label,summary,[role="button"],[onclick],[contenteditable="true"]'))
    .filter(isVisible)
    .slice(0, 120)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      selector: simpleSelector(el),
      text: normalize(el.innerText || el.value || el.getAttribute('aria-label') || el.textContent).slice(0, 160),
      role: el.getAttribute('role') || '',
      type: el.getAttribute('type') || '',
      href: el.href || '',
      box: box(el)
    }));
  const forms = Array.from(document.querySelectorAll('form'))
    .filter(isVisible)
    .slice(0, 30)
    .map((form) => ({
      selector: simpleSelector(form),
      action: form.action || '',
      method: form.method || 'get',
      fields: Array.from(form.querySelectorAll('input,textarea,select'))
        .filter(isVisible)
        .map((field) => ({
          tag: field.tagName.toLowerCase(),
          selector: simpleSelector(field),
          name: field.getAttribute('name') || '',
          type: field.getAttribute('type') || '',
          placeholder: field.getAttribute('placeholder') || '',
          value_length: field.value ? field.value.length : 0
        }))
    }));
  const dialogs = Array.from(document.querySelectorAll('dialog[open],[role="dialog"],.modal.show,.modal[style*="display: block"]'))
    .filter(isVisible)
    .slice(0, 20)
    .map((el) => ({
      selector: simpleSelector(el),
      text: normalize(el.innerText || el.textContent).slice(0, 500),
      box: box(el)
    }));
  const notices = Array.from(document.querySelectorAll('.error,.notice-error,.alert,.directorist-alert,[aria-invalid="true"]'))
    .filter(isVisible)
    .slice(0, 40)
    .map((el) => ({
      selector: simpleSelector(el),
      text: normalize(el.innerText || el.textContent || el.getAttribute('aria-label')).slice(0, 300)
    }));
  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    visible_text: normalize(document.body ? document.body.innerText : '').slice(0, 5000),
    clickables,
    forms,
    dialogs,
    notices,
    captured_at: new Date().toISOString()
  };
})()
`);
  fs.writeFileSync(outputPath, JSON.stringify({ ...snapshot.value, requested_viewport: viewport }, null, 2));
  return outputPath;
}

async function confirmIfRisky(options, rl, action, target) {
  if (options.yes || !RISKY_RE.test(target)) return;
  if (!process.stdin.isTTY) throw new Error(`Risky action needs --yes in non-interactive shell: ${target}`);

  const answer = await rl.question(`Risky ${action} target "${target}". Continue? Type yes: `);
  if (answer.trim().toLowerCase() !== 'yes') {
    throw new Error(`Cancelled risky ${action}: ${target}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.url && options.fixture) {
    options.url = getFixtureUrl(options.fixture);
  }
  if (!options.url) throw new Error('--url is required');

  const viewport = parseViewport(options.viewport);
  const runDir = makeRunDir();
  const actionLog = [];
  const browser = launchChrome(options, runDir);
  const rl = readline.createInterface({ input, output });
  let client;

  try {
    await waitForHttp(`http://127.0.0.1:${options.port}/json/version`, options.timeout);
    client = await CDP({ port: options.port });

    await Promise.all([
      client.Page.enable(),
      client.Runtime.enable(),
      client.DOM.enable(),
      client.Input.setIgnoreInputEvents({ ignore: false }),
      client.Emulation.setDeviceMetricsOverride({
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ]);

    const pageLoaded = new Promise((resolve) => client.Page.loadEventFired(resolve));
    await client.Page.navigate({ url: options.url });
    await Promise.race([pageLoaded, sleep(options.timeout)]);
    await sleep(options.waitMs);

    actionLog.push({ action: 'navigate', url: options.url });

    for (const action of options.actions) {
      if (action.type === 'click') {
        await confirmIfRisky(options, rl, 'click', action.value);
        const point = await realClick(client, action.value, options.timeout);
        actionLog.push({ action: 'click', selector: action.value, point });
        console.log(`clicked: ${action.value} at ${Math.round(point.x)},${Math.round(point.y)}`);
      } else if (action.type === 'type') {
        const { selector, payload } = splitAssignment(action.value, '--type');
        await typeText(client, selector, payload, options.timeout);
        actionLog.push({ action: 'type', selector, chars: payload.length });
        console.log(`typed ${payload.length} chars into: ${selector}`);
      } else if (action.type === 'upload') {
        const { selector, payload } = splitAssignment(action.value, '--upload');
        const uploaded = await uploadFile(client, selector, payload, options.timeout);
        actionLog.push({ action: 'upload', selector, file: uploaded });
        console.log(`uploaded: ${uploaded}`);
      } else if (action.type === 'expect') {
        const found = await waitForElement(client, action.value, options.timeout);
        actionLog.push({ action: 'expect', selector: action.value, found });
        console.log(`expect passed: ${action.value}`);
      } else if (action.type === 'screenshot') {
        const saved = await takeScreenshot(client, action.value, runDir);
        actionLog.push({ action: 'screenshot', file: saved });
        console.log(`screenshot: ${saved}`);
      } else if (action.type === 'snapshot') {
        const saved = await takeSnapshot(client, action.value, runDir, viewport);
        actionLog.push({ action: 'snapshot', file: saved });
        console.log(`snapshot: ${saved}`);
      } else if (action.type === 'wait') {
        await sleep(action.value);
        actionLog.push({ action: 'wait', ms: action.value });
        console.log(`waited: ${action.value}ms`);
      }

      await sleep(options.waitMs);
    }

    fs.writeFileSync(path.join(runDir, 'actions.json'), JSON.stringify(actionLog, null, 2));
    console.log(`run log: ${path.join(runDir, 'actions.json')}`);

    if (!options.keepOpen) {
      await client.Browser.close();
    }
  } catch (error) {
    actionLog.push({ action: 'error', message: error.message });
    fs.writeFileSync(path.join(runDir, 'actions.json'), JSON.stringify(actionLog, null, 2));
    console.error(`run log: ${path.join(runDir, 'actions.json')}`);
    throw error;
  } finally {
    await rl.close();
    if (client) await client.close().catch(() => {});
    if (browser?.shouldCleanupUserDataDir && !options.keepOpen) {
      await sleep(750);
      try {
        fs.rmSync(browser.userDataDir, { recursive: true, force: true });
      } catch {
        // Chrome can hold metrics/cache files briefly after Browser.close().
        // The profile lives in the OS temp folder, so a delayed OS cleanup is acceptable.
      }
    }
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
