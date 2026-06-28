import {
  CookieJar,
  WordPressSession,
  fetchWithSession,
  readActiveTheme,
  readPlugins,
  wordpressAdminPageUrl,
} from './wordpress-tools.mjs';
import { PatchWorkflowStore } from './patch-workflow.mjs';
import { runChromeCdpCheck } from './chrome-cdp.mjs';
import {
  runFileRead,
  runFileSearch,
  runGitDiffSummary,
  runGitStatus,
  runNodeTest,
  runPhpLint,
} from './local-engineering-tools.mjs';

const BLOCKED_TOOL_RE = /(^|[_\W])(write|patch|edit|delete|remove|reset|publish|deploy|merge|payment|checkout|database|db|shell|exec|command|theme_editor|theme-edit|file_patch|file-patch)([_\W]|$)/i;
const MAX_TEXT_SAMPLE = 1600;

export function createToolRegistry(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const artifactRoot = options.artifactRoot;
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const patchStore = new PatchWorkflowStore({
    workspaceRoot,
    patchRoot: options.patchRoot,
  });
  const tools = new Map([
    ['http_get', (input) => runHttpGet(input, { fetchImpl })],
    ['wp_active_theme', (input) => runWordPressActiveTheme(input, { fetchImpl })],
    ['wp_plugins', (input) => runWordPressPlugins(input, { fetchImpl })],
    ['wp_overview', (input) => runWordPressOverview(input, { fetchImpl })],
    ['file_read', (input) => runFileRead(input, { workspaceRoot })],
    ['file_search', (input) => runFileSearch(input, { workspaceRoot })],
    ['git_status', (input) => runGitStatus(input, { workspaceRoot })],
    ['git_diff_summary', (input) => runGitDiffSummary(input, { workspaceRoot })],
    ['php_lint', (input) => runPhpLint(input, { workspaceRoot })],
    ['node_test', (input) => runNodeTest(input, { workspaceRoot })],
    ['file_change_prepare', (input) => runFileChangePrepare(input, { patchStore })],
    ['file_change_check', (input) => runFileChangeCheck(input, { patchStore })],
    ['file_change_apply', (input) => runFileChangeApply(input, { patchStore })],
    ['chrome_cdp_check', (input) => runChromeCdpTool(input, {
      fetchImpl,
      WebSocketImpl: options.WebSocketImpl || globalThis.WebSocket,
      artifactRoot,
    })],
  ]);

  return {
    list() {
      return [...tools.keys()];
    },

    async run(toolName, input = {}) {
      const name = normalizeToolName(toolName);

      if (isBlockedToolName(name)) {
        return blockedToolResult(name);
      }

      const tool = tools.get(name);
      if (!tool) {
        return {
          ok: false,
          status: 400,
          error: 'tool_not_allowed',
          evidence: {
            type: 'tool_blocked',
            title: `Tool not allowed: ${name || 'unknown'}`,
            summary: 'The bridge only exposes a small read-only tool allowlist.',
          },
          payload: {
            tool: name,
            allowed_tools: [...tools.keys()],
          },
        };
      }

      try {
        return await tool(isPlainObject(input) ? input : {});
      } catch (error) {
        const normalizedError = normalizeToolError(error);
        return {
          ok: false,
          status: normalizedError.status,
          error: normalizedError.code,
          evidence: {
            type: 'tool_error',
            title: `Tool failed: ${name}`,
            summary: error?.message || 'The tool failed before returning evidence.',
          },
          payload: {
            tool: name,
            error: error?.stack || error?.message || String(error),
          },
        };
      }
    },
  };
}

export function isBlockedToolName(toolName) {
  const name = normalizeToolName(toolName);
  return !name || BLOCKED_TOOL_RE.test(name);
}

function normalizeToolError(error) {
  const message = error?.message || '';
  if (/approved:\s*true|approval/i.test(message)) {
    return { status: 403, code: 'approval_required' };
  }
  if (/outside the allowed workspace root|outside the patch workflow root/i.test(message)) {
    return { status: 403, code: 'path_not_allowed' };
  }
  if (/changed since backup|stale/i.test(message)) {
    return { status: 409, code: 'stale_patch_workflow' };
  }
  return { status: 500, code: 'tool_failed' };
}

async function runHttpGet(input, options = {}) {
  const url = requireUrl(input.url);
  const result = await fetchWithSession(url, {
    fetchImpl: options.fetchImpl,
    maxRedirects: safeInteger(input.max_redirects, 8, 0, 12),
  }, {
    cookieJar: new CookieJar(),
  });
  const compact = compactHttpResult(result);

  return {
    ok: true,
    status: 200,
    result: compact,
    evidence: {
      type: 'http',
      title: `HTTP GET ${hostLabel(compact.url || url)}`,
      summary: `Returned ${compact.status} from ${compact.url || url}.`,
    },
    payload: {
      tool: 'http_get',
      input: { url },
      result: compact,
    },
  };
}

async function runWordPressActiveTheme(input, options = {}) {
  const session = await createWordPressSession(input, options);
  const result = await readActiveTheme(session, input.admin_url || input.adminUrl || input.entry_url || input.entryUrl);
  const compact = {
    active_theme: result.activeTheme,
    page: result.page,
  };

  return {
    ok: true,
    status: 200,
    result: compact,
    evidence: {
      type: 'wordpress',
      title: 'WordPress active theme',
      summary: result.activeTheme
        ? `Active theme: ${result.activeTheme.name || result.activeTheme.slug}.`
        : `Active theme was not detected from ${result.page?.url || 'the admin themes page'}.`,
    },
    payload: {
      tool: 'wp_active_theme',
      input: redactedWordPressInput(input),
      result: compact,
    },
  };
}

async function runWordPressPlugins(input, options = {}) {
  const session = await createWordPressSession(input, options);
  const result = await readPlugins(session, input.admin_url || input.adminUrl || input.entry_url || input.entryUrl);
  const compact = {
    plugins_count: result.plugins.length,
    directorist_plugins: result.directoristPlugins,
    plugins: result.plugins.map(compactPlugin),
    page: result.page,
  };

  return {
    ok: true,
    status: 200,
    result: compact,
    evidence: {
      type: 'wordpress',
      title: 'WordPress plugins',
      summary: `${result.plugins.length} plugin rows found; ${result.directoristPlugins.length} Directorist-related plugin rows found.`,
    },
    payload: {
      tool: 'wp_plugins',
      input: redactedWordPressInput(input),
      result: compact,
    },
  };
}

async function runWordPressOverview(input, options = {}) {
  const session = await createWordPressSession(input, options);
  const adminUrl = input.admin_url || input.adminUrl || input.entry_url || input.entryUrl;
  const [theme, plugins] = await Promise.all([
    readActiveTheme(session, adminUrl),
    readPlugins(session, adminUrl),
  ]);
  const compact = {
    active_theme: theme.activeTheme,
    plugins_count: plugins.plugins.length,
    directorist_plugins: plugins.directoristPlugins,
    pages: {
      theme: theme.page,
      plugins: plugins.page,
    },
  };

  return {
    ok: true,
    status: 200,
    result: compact,
    evidence: {
      type: 'wordpress',
      title: 'WordPress admin overview',
      summary: [
        theme.activeTheme ? `Active theme: ${theme.activeTheme.name || theme.activeTheme.slug}.` : 'Active theme not detected.',
        `${plugins.directoristPlugins.length} Directorist-related plugin rows found.`,
      ].join(' '),
    },
    payload: {
      tool: 'wp_overview',
      input: redactedWordPressInput(input),
      result: compact,
    },
  };
}

async function runFileChangePrepare(input, options = {}) {
  const result = await options.patchStore.prepare(input);

  return {
    ok: true,
    status: 200,
    result,
    evidence: {
      type: 'patch_workflow',
      title: 'Prepared file change',
      summary: result.changed
        ? `Backup and patched copy created for ${result.target_relative_path}.`
        : `Backup and patched copy created for ${result.target_relative_path}; content is unchanged.`,
    },
    payload: {
      tool: 'file_change_prepare',
      result,
    },
  };
}

async function runFileChangeCheck(input, options = {}) {
  const result = await options.patchStore.check(input);

  return {
    ok: result.ok,
    status: result.ok ? 200 : 422,
    result,
    error: result.ok ? null : 'patch_check_failed',
    evidence: {
      type: 'patch_check',
      title: `Patch check: ${result.checker}`,
      summary: `${result.checker} exited with ${result.exit_code}.`,
    },
    payload: {
      tool: 'file_change_check',
      result,
    },
  };
}

async function runFileChangeApply(input, options = {}) {
  const result = await options.patchStore.apply(input);

  return {
    ok: true,
    status: 200,
    result,
    evidence: {
      type: 'patch_apply',
      title: 'Applied prepared file change',
      summary: `Applied prepared change to ${result.target_relative_path}.`,
    },
    payload: {
      tool: 'file_change_apply',
      result,
    },
  };
}

async function runChromeCdpTool(input, options = {}) {
  const result = await runChromeCdpCheck(input, options);
  const selector = result.assertion?.selector || result.assertion?.expression || '';

  return {
    ok: result.ok,
    status: result.ok ? 200 : 422,
    result,
    error: result.ok ? null : 'browser_assertion_failed',
    evidence: {
      type: 'browser_verification',
      title: selector ? `Chrome CDP check: ${selector}` : 'Chrome CDP check',
      summary: [
        result.target?.url ? `Target: ${result.target.url}.` : '',
        result.assertion ? `Assertion ${result.assertion.ok ? 'passed' : 'failed'}.` : 'Connected to target.',
        result.screenshot?.path ? `Screenshot: ${result.screenshot.path}` : '',
      ].filter(Boolean).join(' '),
    },
    payload: {
      tool: 'chrome_cdp_check',
      result,
    },
  };
}

async function createWordPressSession(input, options = {}) {
  const entryUrl = input.entry_url || input.entryUrl || input.login_url || input.loginUrl || input.admin_url || input.adminUrl;
  const adminUrl = input.admin_url || input.adminUrl || entryUrl;
  if (!entryUrl && !adminUrl) throw new Error('WordPress tool requires admin_url, entry_url, or login_url.');

  const session = new WordPressSession({
    entryUrl: entryUrl || adminUrl,
    fetchImpl: options.fetchImpl,
  });

  const username = input.username || input.user || '';
  const password = input.password || input.pass || '';
  if (username && password) {
    await session.login({
      loginUrl: input.login_url || input.loginUrl || entryUrl || adminUrl,
      username,
      password,
      redirectTo: wordpressAdminPageUrl(adminUrl, 'index.php'),
    });
  }

  return session;
}

function compactHttpResult(result = {}) {
  const contentType = result.headers?.['content-type'] || '';
  const text = normalizeText(result.body || '');
  return {
    ok: Boolean(result.ok),
    status: result.status || 0,
    url: result.url || '',
    redirected: Boolean(result.redirected),
    redirects: Array.isArray(result.redirects) ? result.redirects : [],
    content_type: contentType,
    title: htmlTitle(result.body),
    text_sample: text.slice(0, MAX_TEXT_SAMPLE),
  };
}

function compactPlugin(plugin = {}) {
  return {
    slug: plugin.slug || '',
    file: plugin.file || '',
    name: plugin.name || '',
    active: Boolean(plugin.active),
  };
}

function redactedWordPressInput(input = {}) {
  const redacted = {
    admin_url: input.admin_url || input.adminUrl || '',
    entry_url: input.entry_url || input.entryUrl || '',
    login_url: input.login_url || input.loginUrl || '',
    username: input.username || input.user ? '[provided]' : '',
    password: input.password || input.pass ? '[redacted]' : '',
  };
  return Object.fromEntries(Object.entries(redacted).filter(([, value]) => value));
}

function blockedToolResult(name) {
  return {
    ok: false,
    status: 403,
    error: 'tool_blocked',
    evidence: {
      type: 'tool_blocked',
      title: `Blocked tool: ${name || 'unknown'}`,
      summary: 'This tool name indicates a write, shell, deploy, database, payment, or destructive action. The read-only bridge did not execute it.',
    },
    payload: {
      tool: name,
      blocked: true,
      reason: 'read_only_tool_registry',
    },
  };
}

function requireUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Tool input requires a URL.');
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  const url = new URL(withProtocol);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  return url.toString();
}

function normalizeToolName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function safeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function hostLabel(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname || rawUrl;
  } catch {
    return rawUrl;
  }
}

function htmlTitle(html = '') {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? normalizeText(stripTags(match[1])) : '';
}

function normalizeText(value) {
  return stripTags(value).replace(/\s+/g, ' ').trim();
}

function stripTags(html = '') {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
