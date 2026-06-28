import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createBridgeServer, DEFAULT_TOKEN } from '../src/server.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createHttpFixtureServer() {
  return http.createServer((req, res) => {
    if (req.url === '/public-page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Public Fixture</title><p>Fixture evidence body.</p>');
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
}

function makeChromeFetch() {
  return async (url) => {
    assert.match(String(url), /\/json\/list$/);
    return {
      ok: true,
      status: 200,
      async json() {
        return [
          {
            id: 'page-1',
            type: 'page',
            title: 'Fixture Homepage',
            url: 'https://example.test/',
            webSocketDebuggerUrl: 'ws://fixture/page-1',
          },
        ];
      },
    };
  };
}

function makeChromeWebSocket() {
  return class MockWebSocket {
    constructor() {
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
      }, 0);
    }

    send(rawMessage) {
      const message = JSON.parse(rawMessage);
      const result = message.method === 'Runtime.evaluate'
        ? {
          result: {
            type: 'object',
            value: {
              exists: true,
              visible: true,
              text: 'Act Directory Filters Search 12 Items Found Performer/Act Name La Scarlet Burlesque',
              rect: { x: 0, y: 0, width: 1440, height: 900 },
              layout: {
                viewport_width: 1440,
                viewport_height: 900,
                document_width: 1440,
                document_height: 1200,
                horizontal_overflow: false,
              },
              clickables: [{ text: 'Filters' }, { text: 'Search' }],
              images: [{ alt: 'La Scarlet', box: { x: 0, y: 0, width: 280, height: 180 } }],
            },
          },
        }
        : {};
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) });
        if (message.method === 'Page.navigate') {
          this.onmessage?.({ data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }) });
        }
      }, 0);
    }

    close() {
      this.readyState = 3;
    }
  };
}

test('bridge preflight allows Chrome extension access to local bridge', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fluid-bridge-cors-'));
  const server = createBridgeServer({ cwd, provider: 'local', token: DEFAULT_TOKEN });

  try {
    const address = await listen(server);
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'OPTIONS',
      headers: {
        origin: 'chrome-extension://fixture-extension',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-arafatai-token',
        'access-control-request-private-network': 'true',
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-headers') || '', /x-arafatai-token/i);
    assert.match(response.headers.get('access-control-allow-methods') || '', /POST/i);
    assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
  } finally {
    await close(server).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});

test('task creation stores classification and evidence checkpoint', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fluid-bridge-server-'));
  const server = createBridgeServer({ cwd, provider: 'local', token: DEFAULT_TOKEN });

  try {
    const address = await listen(server);
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        goal: 'Geo locating search returns no results in Directorist radius search',
        history: [],
        conversation_memory: {},
      }),
    });

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.task.task_classification.task_type, 'investigation');
    assert.equal(data.task.task_classification.domain, 'directorist');
    assert.equal(data.task.evidence.length, 1);
    assert.equal(data.task.evidence[0].type, 'classification');
    assert.match(data.task.evidence[0].path, /001-initial-task-classification\.json$/);
  } finally {
    await close(server).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});

test('task tool endpoint runs read-only tool and stores evidence', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fluid-bridge-server-'));
  const server = createBridgeServer({ cwd, provider: 'local', token: DEFAULT_TOKEN });
  const fixture = createHttpFixtureServer();

  try {
    const [address, fixtureAddress] = await Promise.all([listen(server), listen(fixture)]);
    const taskResponse = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        goal: 'Check public page evidence before fixing',
        history: [],
        conversation_memory: {},
      }),
    });
    const taskData = await taskResponse.json();

    const toolResponse = await fetch(`http://127.0.0.1:${address.port}/tasks/${taskData.task.id}/tool`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        tool: 'http_get',
        input: {
          url: `http://127.0.0.1:${fixtureAddress.port}/public-page`,
        },
      }),
    });

    assert.equal(toolResponse.status, 200);
    const toolData = await toolResponse.json();
    assert.equal(toolData.ok, true);
    assert.equal(toolData.result.title, 'Public Fixture');
    assert.equal(toolData.evidence.type, 'http');
    assert.equal(toolData.task.evidence.length, 2);
    assert.match(toolData.task.evidence[1].path, /002-http-get-/);
  } finally {
    await Promise.all([
      close(server).catch(() => {}),
      close(fixture).catch(() => {}),
    ]);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('plan request includes compact stored browser verification payload', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fluid-bridge-browser-memory-'));
  const script = path.join(cwd, 'fake-python-core.mjs');
  await writeFile(
    script,
    `
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const body = JSON.parse(raw || '{}');
  const evidence = Array.isArray(body.task_memory?.evidence) ? body.task_memory.evidence : [];
  const browser = evidence.find((item) => item.type === 'browser_verification');
  const assertion = browser?.payload?.result?.assertion || {};
  const hasPayload = browser?.payload?.tool === 'chrome_cdp_check'
    && /Act Directory/.test(assertion.text || '')
    && assertion.layout?.horizontal_overflow === false
    && Array.isArray(assertion.images)
    && assertion.images[0]?.box?.width === 280;
  process.stdout.write(JSON.stringify({
    ok: true,
    text: JSON.stringify({
      reply: hasPayload ? 'Stored browser payload available.' : 'Stored browser payload missing.',
      reasoning_summary: [hasPayload ? 'CDP payload was compacted into task memory.' : 'No compact payload was found.'],
      questions: [],
      actions: [],
      done: hasPayload,
      needs_approval: false
    }),
    source: 'python-core-test',
    error: null
  }));
});
`,
    'utf8',
  );
  const server = createBridgeServer({
    cwd,
    provider: 'python-core',
    pythonCommand: process.execPath,
    pythonArgs: [script],
    token: DEFAULT_TOKEN,
    fetchImpl: makeChromeFetch(),
    WebSocketImpl: makeChromeWebSocket(),
  });

  try {
    const address = await listen(server);
    const taskResponse = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        goal: 'Retest the homepage after Directorist activation.',
        history: [],
        conversation_memory: {},
      }),
    });
    const taskData = await taskResponse.json();

    await fetch(`http://127.0.0.1:${address.port}/tasks/${taskData.task.id}/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        kind: 'observation',
        status: 'running',
        step: 1,
        action: {
          type: 'click',
          reason: 'Activate the required base Directorist plugin from its exact Plugins-page control.',
        },
        result: {
          ok: true,
          href: 'https://example.test/wp-admin/plugins.php?action=activate&plugin=directorist%2Fdirectorist-base.php&_wpnonce=base',
        },
        message: 'Plugin activated.',
      }),
    });

    const toolResponse = await fetch(`http://127.0.0.1:${address.port}/tasks/${taskData.task.id}/tool`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        tool: 'chrome_cdp_check',
        input: {
          browser_url: 'http://127.0.0.1:9222',
          url_contains: 'example.test',
          navigate_url: 'https://example.test/',
          selector: 'body',
          expect_visible: true,
        },
      }),
    });
    assert.equal(toolResponse.status, 200);

    const planResponse = await fetch(`http://127.0.0.1:${address.port}/tasks/${taskData.task.id}/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        page: {
          url: 'https://example.test/',
          title: 'Fixture Homepage',
          visible_text: 'Nightlife Community Hub Resources Info Connect',
        },
        task_state: { step: 2 },
      }),
    });
    assert.equal(planResponse.status, 200);
    const planData = await planResponse.json();
    const payload = JSON.parse(planData.text);
    assert.equal(payload.reply, 'Stored browser payload available.');
    assert.equal(payload.done, true);
  } finally {
    await close(server).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});

test('task tool endpoint blocks write-like tools and stores blocked evidence', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fluid-bridge-server-'));
  const server = createBridgeServer({ cwd, provider: 'local', token: DEFAULT_TOKEN });

  try {
    const address = await listen(server);
    const taskResponse = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        goal: 'Fix child theme after evidence',
        history: [],
        conversation_memory: {},
      }),
    });
    const taskData = await taskResponse.json();

    const toolResponse = await fetch(`http://127.0.0.1:${address.port}/tasks/${taskData.task.id}/tool`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        tool: 'file_patch',
        input: {
          path: 'functions.php',
        },
      }),
    });

    assert.equal(toolResponse.status, 403);
    const toolData = await toolResponse.json();
    assert.equal(toolData.ok, false);
    assert.equal(toolData.error, 'tool_blocked');
    assert.equal(toolData.evidence.type, 'tool_blocked');
    assert.equal(toolData.task.evidence.length, 2);
  } finally {
    await close(server).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});

test('task tool endpoint prepares and approval-gates file changes', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fluid-bridge-server-'));
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  const target = path.join(cwd, 'src', 'demo.js');
  await writeFile(target, 'const value = 1;\n', 'utf8');
  const server = createBridgeServer({ cwd, provider: 'local', token: DEFAULT_TOKEN });

  try {
    const address = await listen(server);
    const taskResponse = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        goal: 'Prepare a safe local file fix',
        history: [],
        conversation_memory: {},
      }),
    });
    const taskData = await taskResponse.json();

    const prepareResponse = await fetch(`http://127.0.0.1:${address.port}/tasks/${taskData.task.id}/tool`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        tool: 'file_change_prepare',
        input: {
          target_path: 'src/demo.js',
          patched_content: 'const value = 2;\n',
          label: 'demo safe patch',
        },
      }),
    });
    assert.equal(prepareResponse.status, 200);
    const prepareData = await prepareResponse.json();
    assert.equal(prepareData.ok, true);
    assert.equal(prepareData.result.target_relative_path, 'src/demo.js');
    assert.equal(await readFile(target, 'utf8'), 'const value = 1;\n');

    const blockedApplyResponse = await fetch(`http://127.0.0.1:${address.port}/tasks/${taskData.task.id}/tool`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        tool: 'file_change_apply',
        input: {
          workflow_id: prepareData.result.workflow_id,
        },
      }),
    });
    assert.equal(blockedApplyResponse.status, 403);
    const blockedApplyData = await blockedApplyResponse.json();
    assert.equal(blockedApplyData.error, 'approval_required');
    assert.equal(await readFile(target, 'utf8'), 'const value = 1;\n');

    const applyResponse = await fetch(`http://127.0.0.1:${address.port}/tasks/${taskData.task.id}/tool`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        tool: 'file_change_apply',
        input: {
          workflow_id: prepareData.result.workflow_id,
          approved: true,
        },
      }),
    });
    assert.equal(applyResponse.status, 200);
    const applyData = await applyResponse.json();
    assert.equal(applyData.ok, true);
    assert.equal(applyData.evidence.type, 'patch_apply');
    assert.equal(await readFile(target, 'utf8'), 'const value = 2;\n');
  } finally {
    await close(server).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});

test('reason endpoint can use python-core provider without changing HTTP contract', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fluid-bridge-python-core-'));
  const script = path.join(cwd, 'fake-python-core.mjs');
  await writeFile(
    script,
    `
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const body = JSON.parse(raw || '{}');
  process.stdout.write(JSON.stringify({
    ok: true,
    text: JSON.stringify({
      reply: 'Handled by Python core: ' + body.goal,
      reasoning_summary: ['HTTP bridge reached Python core provider.'],
      questions: [],
      actions: [],
      done: true,
      needs_approval: false
    }),
    source: 'python-core-test',
    error: null
  }));
});
`,
    'utf8',
  );
  const server = createBridgeServer({
    cwd,
    provider: 'python-core',
    pythonCommand: process.execPath,
    pythonArgs: [script],
    token: DEFAULT_TOKEN,
  });

  try {
    const address = await listen(server);
    const response = await fetch(`http://127.0.0.1:${address.port}/reason`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arafatai-token': DEFAULT_TOKEN,
      },
      body: JSON.stringify({
        mode: 'agent_task',
        goal: 'inspect current page',
        page: { url: 'https://example.test/', title: 'Example' },
      }),
    });

    assert.equal(response.status, 200);
    const data = await response.json();
    const payload = JSON.parse(data.text);
    assert.equal(data.ok, true);
    assert.equal(data.source, 'python-core-test');
    assert.equal(payload.reply, 'Handled by Python core: inspect current page');
    assert.equal(payload.done, true);
    assert.equal(data.task_classification.task_type, 'unknown');
  } finally {
    await close(server).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});
