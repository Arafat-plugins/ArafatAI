import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import {
  CookieJar,
  WordPressSession,
  extractForms,
  fetchWithSession,
  findWordPressLoginForm,
  normalizeWordPressEntryUrl,
  parseActiveTheme,
  parsePluginRows,
  readActiveTheme,
  readPlugins,
  wordpressAdminPageUrl,
} from '../src/wordpress-tools.mjs';

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

function createWordPressFixtureServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

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
          <input type="text" name="log" value="">
          <input type="password" name="pwd" value="">
          <input type="submit" name="wp-submit" value="Log In">
        </form>
      `);
      return;
    }

    if (url.pathname === '/private-login' && req.method === 'POST') {
      const fields = new URLSearchParams(await readBody(req));
      assert.equal(fields.get('log'), 'support');
      assert.equal(fields.get('pwd'), 'secret');
      assert.equal(fields.get('testcookie'), '1');
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
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`
        <div class="theme" data-slug="twentytwentysix"><h2 class="theme-name">Twenty Twenty-Six</h2></div>
        <div class="theme active" data-slug="drestaurant-child">
          <h2 class="theme-name"><span>Active:</span> dRestaurant Child</h2>
        </div>
      `);
      return;
    }

    if (url.pathname === '/wp-admin/plugins.php') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`
        <table>
          <tr class="active" data-slug="directorist" data-plugin="directorist/directorist-base.php">
            <td class="plugin-title"><strong>Directorist</strong></td>
          </tr>
          <tr class="inactive" data-slug="hello-dolly" data-plugin="hello.php">
            <td class="plugin-title"><strong>Hello Dolly</strong></td>
          </tr>
        </table>
      `);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });
}

test('normalizes user supplied WordPress entry URL without guessing wp-login.php', () => {
  assert.equal(
    normalizeWordPressEntryUrl('example.com/dashboard'),
    'https://example.com/dashboard',
  );
  assert.equal(
    wordpressAdminPageUrl('https://example.com/dashboard', 'themes.php'),
    'https://example.com/wp-admin/themes.php',
  );
});

test('fetchWithSession follows redirects and carries cookies', async () => {
  const server = createWordPressFixtureServer();
  try {
    const address = await listen(server);
    const jar = new CookieJar();
    const result = await fetchWithSession(`http://127.0.0.1:${address.port}/dashboard`, {}, { cookieJar: jar });

    assert.equal(result.status, 200);
    assert.equal(result.redirects.length, 1);
    assert.match(result.body, /loginform/);
    assert.match(jar.header(`http://127.0.0.1:${address.port}/private-login`), /route_seen=1/);
  } finally {
    await close(server).catch(() => {});
  }
});

test('WordPressSession logs in through hidden dashboard route', async () => {
  const server = createWordPressFixtureServer();
  try {
    const address = await listen(server);
    const entryUrl = `http://127.0.0.1:${address.port}/dashboard`;
    const session = new WordPressSession({ entryUrl });
    const result = await session.login({ username: 'support', password: 'secret' });

    assert.equal(result.status, 200);
    assert.equal(result.url, `http://127.0.0.1:${address.port}/wp-admin/`);
    assert.match(result.body, /Dashboard/);
  } finally {
    await close(server).catch(() => {});
  }
});

test('extracts WordPress login form action and fields', () => {
  const forms = extractForms(`
    <form method="post" action="/secret">
      <input type="hidden" name="nonce" value="abc">
      <input name="log">
      <input name="pwd" type="password">
    </form>
  `, 'https://example.test/dashboard');
  const loginForm = findWordPressLoginForm(`
    <form method="post" action="/secret">
      <input type="hidden" name="nonce" value="abc">
      <input name="log">
      <input name="pwd" type="password">
    </form>
  `, 'https://example.test/dashboard');

  assert.equal(forms[0].action, 'https://example.test/secret');
  assert.equal(forms[0].fields.nonce, 'abc');
  assert.equal(loginForm.action, 'https://example.test/secret');
});

test('parses active theme and plugin rows from admin HTML', () => {
  const theme = parseActiveTheme(`
    <div class="theme" data-slug="parent-theme"><h2 class="theme-name">Parent</h2></div>
    <div class="theme active" data-slug="child-theme">
      <h2 class="theme-name"><span>Active:</span> Child Theme</h2>
    </div>
  `);
  const plugins = parsePluginRows(`
    <tr class="active" data-slug="directorist" data-plugin="directorist/directorist-base.php">
      <td><strong>Directorist</strong></td>
    </tr>
    <tr class="inactive" data-plugin="hello.php">
      <td><strong>Hello Dolly</strong></td>
    </tr>
  `);

  assert.deepEqual(theme, {
    slug: 'child-theme',
    name: 'Child Theme',
    stylesheet: 'child-theme',
  });
  assert.equal(plugins.length, 2);
  assert.equal(plugins[0].name, 'Directorist');
  assert.equal(plugins[0].active, true);
  assert.equal(plugins[1].slug, 'hello.php');
  assert.equal(plugins[1].active, false);
});

test('reads active theme and Directorist plugins from admin pages', async () => {
  const server = createWordPressFixtureServer();
  try {
    const address = await listen(server);
    const adminUrl = `http://127.0.0.1:${address.port}/wp-admin/`;
    const session = new WordPressSession({ entryUrl: adminUrl });
    const theme = await readActiveTheme(session, adminUrl);
    const plugins = await readPlugins(session, adminUrl);

    assert.equal(theme.activeTheme.slug, 'drestaurant-child');
    assert.equal(theme.page.status, 200);
    assert.equal(plugins.plugins.length, 2);
    assert.equal(plugins.directoristPlugins.length, 1);
    assert.equal(plugins.directoristPlugins[0].slug, 'directorist');
  } finally {
    await close(server).catch(() => {});
  }
});
