import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createToolRegistry } from '../src/tool-registry.mjs';

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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function createFixtureServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Fixture Page</title><main>Hello from the fixture page.</main>');
      return;
    }

    if (url.pathname === '/dashboard') {
      res.writeHead(302, {
        location: '/private-login',
        'set-cookie': 'route_seen=1; Path=/',
      });
      res.end();
      return;
    }

    if (url.pathname === '/private-login' && req.method === 'GET') {
      assert.match(req.headers.cookie || '', /route_seen=1/);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`
        <form id="loginform" method="post" action="/private-login">
          <input type="hidden" name="testcookie" value="1">
          <input name="log">
          <input name="pwd" type="password">
          <input type="submit" name="wp-submit" value="Log In">
        </form>
      `);
      return;
    }

    if (url.pathname === '/private-login' && req.method === 'POST') {
      const fields = new URLSearchParams(await readBody(req));
      assert.equal(fields.get('log'), 'support');
      assert.equal(fields.get('pwd'), 'secret');
      res.writeHead(302, {
        location: '/wp-admin/',
        'set-cookie': 'wordpress_logged_in_fixture=ok; Path=/',
      });
      res.end();
      return;
    }

    if (url.pathname === '/wp-admin/') {
      assert.match(req.headers.cookie || '', /wordpress_logged_in_fixture=ok/);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Dashboard</h1>');
      return;
    }

    if (url.pathname === '/wp-admin/themes.php') {
      assert.match(req.headers.cookie || '', /wordpress_logged_in_fixture=ok/);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`
        <div class="theme active" data-slug="drestaurant-child">
          <h2 class="theme-name"><span>Active:</span> dRestaurant Child</h2>
        </div>
      `);
      return;
    }

    if (url.pathname === '/wp-admin/plugins.php') {
      assert.match(req.headers.cookie || '', /wordpress_logged_in_fixture=ok/);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`
        <tr class="active" data-slug="directorist" data-plugin="directorist/directorist-base.php">
          <td><strong>Directorist</strong></td>
        </tr>
        <tr class="active" data-slug="directorist-booking" data-plugin="directorist-booking/directorist-booking.php">
          <td><strong>Directorist Booking</strong></td>
        </tr>
      `);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });
}

function makeChromeFetch() {
  return async (url) => {
    if (String(url).endsWith('/json/list')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [{
            id: 'page-1',
            type: 'page',
            title: 'Fixture',
            url: 'https://example.test/page',
            webSocketDebuggerUrl: 'ws://fixture/page-1',
          }];
        },
      };
    }
    return fetch(url);
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
        ? { result: { type: 'object', value: { exists: true, visible: true, text: 'OK', rect: { width: 1, height: 1 } } } }
        : message.method === 'Page.captureScreenshot'
          ? { data: Buffer.from('registry screenshot').toString('base64') }
          : {};
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) }), 0);
    }

    close() {
      this.readyState = 3;
    }
  };
}

test('http_get returns compact read-only evidence', async () => {
  const server = createFixtureServer();
  try {
    const address = await listen(server);
    const registry = createToolRegistry();
    const result = await registry.run('http_get', {
      url: `http://127.0.0.1:${address.port}/page`,
    });

    assert.equal(result.ok, true);
    assert.equal(result.result.status, 200);
    assert.equal(result.result.title, 'Fixture Page');
    assert.match(result.result.text_sample, /Hello from the fixture page/);
    assert.equal(result.evidence.type, 'http');
    assert.doesNotMatch(JSON.stringify(result.payload), /secret/);
  } finally {
    await close(server).catch(() => {});
  }
});

test('wp_overview logs in and returns active theme plus Directorist plugin evidence', async () => {
  const server = createFixtureServer();
  try {
    const address = await listen(server);
    const base = `http://127.0.0.1:${address.port}`;
    const registry = createToolRegistry();
    const result = await registry.run('wp_overview', {
      admin_url: `${base}/wp-admin/`,
      login_url: `${base}/dashboard`,
      username: 'support',
      password: 'secret',
    });

    assert.equal(result.ok, true);
    assert.equal(result.result.active_theme.slug, 'drestaurant-child');
    assert.equal(result.result.directorist_plugins.length, 2);
    assert.match(result.evidence.summary, /Active theme: dRestaurant Child/);
    assert.doesNotMatch(JSON.stringify(result.payload), /secret/);
    assert.match(JSON.stringify(result.payload), /\[redacted\]/);
  } finally {
    await close(server).catch(() => {});
  }
});

test('file_read returns bounded workspace evidence and rejects outside paths', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'fluid-file-read-'));
  try {
    await mkdir(path.join(workspaceRoot, 'src'));
    await writeFile(path.join(workspaceRoot, 'src', 'demo.txt'), 'abcdefg');
    const registry = createToolRegistry({ workspaceRoot });

    const result = await registry.run('file_read', {
      path: 'src/demo.txt',
      max_bytes: 3,
    });

    assert.equal(result.ok, true);
    assert.equal(result.result.path, 'src/demo.txt');
    assert.equal(result.result.bytes, 7);
    assert.equal(result.result.truncated, true);
    assert.equal(result.result.text_sample, 'abc');
    assert.match(result.result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.evidence.type, 'file');

    const outside = await registry.run('file_read', { path: '../outside.txt' });
    assert.equal(outside.ok, false);
    assert.equal(outside.status, 403);
    assert.equal(outside.error, 'path_not_allowed');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('file_search returns rg matches inside the workspace', async () => {
  const rg = spawnSync('rg', ['--version'], { windowsHide: true });
  if (rg.status !== 0) return;

  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'fluid-file-search-'));
  try {
    await mkdir(path.join(workspaceRoot, 'src'));
    await writeFile(path.join(workspaceRoot, 'src', 'demo.js'), 'const marker = "needle";\n');
    const registry = createToolRegistry({ workspaceRoot });

    const result = await registry.run('file_search', {
      pattern: 'needle',
      path: '.',
      glob: '*.js',
    });

    assert.equal(result.ok, true);
    assert.equal(result.result.match_count, 1);
    assert.match(result.result.matches[0], /^src\/demo\.js:1:/);
    assert.equal(result.evidence.type, 'file_search');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('git_status and git_diff_summary return read-only git evidence', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'fluid-git-tools-'));
  try {
    const init = spawnSync('git', ['init', '-q'], { cwd: workspaceRoot, windowsHide: true });
    if (init.status !== 0) return;

    await writeFile(path.join(workspaceRoot, 'demo.txt'), 'demo\n');
    const registry = createToolRegistry({ workspaceRoot });

    const status = await registry.run('git_status', {});
    assert.equal(status.ok, true);
    assert.match(status.result.stdout, /\?\? demo\.txt/);
    assert.equal(status.evidence.type, 'git');

    const diff = await registry.run('git_diff_summary', {});
    assert.equal(diff.ok, true);
    assert.deepEqual(diff.result.files, []);
    assert.equal(diff.evidence.type, 'git');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('node_test runs an explicit bounded command without a shell', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'fluid-node-test-'));
  try {
    await writeFile(path.join(workspaceRoot, 'demo.js'), 'const ok = true;\n');
    const registry = createToolRegistry({ workspaceRoot });

    const result = await registry.run('node_test', {
      command: process.execPath,
      args: ['--check', 'demo.js'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.result.exit_code, 0);
    assert.equal(result.evidence.type, 'test');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('php_lint reports command failure as lint evidence without throwing', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'fluid-php-lint-'));
  try {
    await writeFile(path.join(workspaceRoot, 'demo.php'), '<?php echo "ok";\n');
    const registry = createToolRegistry({ workspaceRoot });

    const result = await registry.run('php_lint', {
      path: 'demo.php',
      php: path.join(workspaceRoot, 'missing-php.exe'),
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.error, 'php_lint_failed');
    assert.equal(result.evidence.type, 'lint');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('write-like tool names are blocked before execution', async () => {
  const registry = createToolRegistry();
  const result = await registry.run('file_patch', {
    path: 'functions.php',
    patch: 'dangerous',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error, 'tool_blocked');
  assert.equal(result.evidence.type, 'tool_blocked');

  const shell = await registry.run('shell_run_safe', { command: 'git status' });
  assert.equal(shell.ok, false);
  assert.equal(shell.status, 403);
  assert.equal(shell.error, 'tool_blocked');
});

test('chrome_cdp_check returns browser verification evidence', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'fluid-cdp-registry-'));
  try {
    const registry = createToolRegistry({
      fetchImpl: makeChromeFetch(),
      WebSocketImpl: makeChromeWebSocket(),
      artifactRoot,
    });
    const result = await registry.run('chrome_cdp_check', {
      browser_url: 'http://127.0.0.1:9222',
      selector: '.ready',
      expect_visible: true,
      screenshot: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.result.assertion.selector, '.ready');
    assert.equal(result.evidence.type, 'browser_verification');
    assert.match(result.evidence.summary, /Assertion passed/);
    assert.match(result.result.screenshot.path, /ready-\d+\.png$/);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
