const DEFAULT_USER_AGENT = 'FLUID WordPress Support Toolkit/0.1';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  storeFrom(response, requestUrl) {
    const setCookieHeaders = getSetCookieHeaders(response?.headers);
    for (const header of setCookieHeaders) {
      this.set(header, requestUrl);
    }
  }

  set(setCookieHeader, requestUrl) {
    const url = new URL(requestUrl);
    const parts = String(setCookieHeader || '').split(';').map((part) => part.trim()).filter(Boolean);
    const [pair, ...attributes] = parts;
    if (!pair || !pair.includes('=')) return;

    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1);
    if (!name) return;

    const cookie = {
      name,
      value,
      domain: url.hostname.toLowerCase(),
      hostOnly: true,
      path: defaultCookiePath(url.pathname),
      secure: false,
      expires: null,
    };

    for (const rawAttribute of attributes) {
      const [rawKey, ...rawValueParts] = rawAttribute.split('=');
      const key = rawKey.trim().toLowerCase();
      const rawValue = rawValueParts.join('=').trim();

      if (key === 'domain' && rawValue) {
        cookie.domain = rawValue.replace(/^\./, '').toLowerCase();
        cookie.hostOnly = false;
      } else if (key === 'path' && rawValue) {
        cookie.path = rawValue.startsWith('/') ? rawValue : `/${rawValue}`;
      } else if (key === 'secure') {
        cookie.secure = true;
      } else if (key === 'max-age' && Number(rawValue) <= 0) {
        this.cookies.delete(cookieKey(cookie));
        return;
      } else if (key === 'expires') {
        const expires = Date.parse(rawValue);
        if (!Number.isNaN(expires)) cookie.expires = expires;
      }
    }

    if (cookie.expires && cookie.expires <= Date.now()) {
      this.cookies.delete(cookieKey(cookie));
      return;
    }

    this.cookies.set(cookieKey(cookie), cookie);
  }

  header(requestUrl) {
    const url = new URL(requestUrl);
    const now = Date.now();
    const matches = [];

    for (const [key, cookie] of this.cookies.entries()) {
      if (cookie.expires && cookie.expires <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (cookie.secure && url.protocol !== 'https:') continue;
      if (!domainMatches(url.hostname, cookie.domain, cookie.hostOnly)) continue;
      if (!url.pathname.startsWith(cookie.path)) continue;
      matches.push(cookie);
    }

    matches.sort((a, b) => b.path.length - a.path.length);
    return matches.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  entries() {
    return [...this.cookies.values()].map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      hostOnly: cookie.hostOnly,
    }));
  }
}

export class WordPressSession {
  constructor(options = {}) {
    this.entryUrl = normalizeWordPressEntryUrl(options.entryUrl || '');
    this.cookieJar = options.cookieJar || new CookieJar();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
  }

  async get(url, options = {}) {
    return this.request(url, { ...options, method: 'GET' });
  }

  async postForm(url, fields = {}, options = {}) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields || {})) {
      if (value === undefined || value === null) continue;
      body.set(key, String(value));
    }
    return this.request(url, {
      ...options,
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(options.headers || {}),
      },
    });
  }

  async request(url, options = {}) {
    const targetUrl = resolveUrl(url, this.entryUrl);
    return fetchWithSession(targetUrl, {
      ...options,
      fetchImpl: this.fetchImpl,
      userAgent: this.userAgent,
    }, {
      cookieJar: this.cookieJar,
    });
  }

  async login(options = {}) {
    const loginUrl = resolveUrl(options.loginUrl || this.entryUrl, this.entryUrl);
    const username = options.username || '';
    const password = options.password || '';
    const loginPage = await this.get(loginUrl);
    const loginForm = findWordPressLoginForm(loginPage.body, loginPage.url);

    if (!loginForm) {
      throw new Error('No WordPress login form was found on the resolved login route.');
    }

    const fields = {
      ...loginForm.fields,
      ...(options.extraFields || {}),
      log: username,
      pwd: password,
      'wp-submit': options.submitLabel || 'Log In',
    };

    if (options.redirectTo && !fields.redirect_to) {
      fields.redirect_to = options.redirectTo;
    }

    return this.postForm(loginForm.action || loginPage.url, fields, {
      maxRedirects: options.maxRedirects,
    });
  }
}

export async function fetchWithSession(rawUrl, options = {}, context = {}) {
  if (!rawUrl) throw new Error('fetchWithSession requires a URL.');

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation is available.');

  const cookieJar = context.cookieJar || options.cookieJar || new CookieJar();
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : 8;
  const redirects = [];
  let currentUrl = normalizeWordPressEntryUrl(rawUrl);
  let method = String(options.method || 'GET').toUpperCase();
  let body = options.body;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const headers = new Headers(options.headers || {});
    if (!headers.has('user-agent')) headers.set('user-agent', options.userAgent || DEFAULT_USER_AGENT);

    const cookieHeader = cookieJar.header(currentUrl);
    if (cookieHeader && !headers.has('cookie')) headers.set('cookie', cookieHeader);

    const response = await fetchImpl(currentUrl, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
    });

    cookieJar.storeFrom(response, currentUrl);

    const location = response.headers.get('location');
    if (REDIRECT_STATUSES.has(response.status) && location && redirectCount < maxRedirects) {
      const nextUrl = new URL(location, currentUrl).toString();
      redirects.push({ status: response.status, from: currentUrl, to: nextUrl });
      currentUrl = nextUrl;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }

    return {
      ok: response.ok,
      status: response.status,
      url: currentUrl,
      redirected: redirects.length > 0,
      redirects,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
      cookies: cookieJar.entries(),
    };
  }

  throw new Error(`Too many redirects while requesting ${rawUrl}.`);
}

export function normalizeWordPressEntryUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  return url.toString();
}

export function wordpressAdminPageUrl(rawUrl, page = 'index.php') {
  const normalized = normalizeWordPressEntryUrl(rawUrl);
  const url = new URL(normalized);
  const pagePath = String(page || 'index.php').replace(/^\/+/, '');
  return new URL(`/wp-admin/${pagePath}`, url.origin).toString();
}

export async function readActiveTheme(session, adminUrl) {
  const page = await session.get(wordpressAdminPageUrl(adminUrl, 'themes.php'));
  return {
    page: compactPage(page),
    activeTheme: parseActiveTheme(page.body),
  };
}

export async function readPlugins(session, adminUrl) {
  const page = await session.get(wordpressAdminPageUrl(adminUrl, 'plugins.php'));
  const plugins = parsePluginRows(page.body);
  return {
    page: compactPage(page),
    plugins,
    directoristPlugins: plugins.filter((plugin) => /directorist|atbdp|booking/i.test(`${plugin.name} ${plugin.slug} ${plugin.file}`)),
  };
}

export function extractForms(html = '', baseUrl = '') {
  const forms = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match;

  while ((match = formRe.exec(String(html || '')))) {
    const attrs = parseAttributes(match[1]);
    const body = match[2] || '';
    const fields = {};
    const inputs = [];
    const inputRe = /<(input|button|textarea)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gi;
    let inputMatch;

    while ((inputMatch = inputRe.exec(body))) {
      const tag = inputMatch[1].toLowerCase();
      const inputAttrs = parseAttributes(inputMatch[2]);
      const name = inputAttrs.name || '';
      const value = tag === 'textarea' ? stripTags(inputMatch[3] || '') : inputAttrs.value || '';
      const input = {
        tag,
        name,
        type: inputAttrs.type || '',
        value,
      };
      inputs.push(input);
      if (name && !['checkbox', 'radio'].includes(input.type.toLowerCase())) {
        fields[name] = value;
      }
    }

    forms.push({
      action: attrs.action ? resolveUrl(attrs.action, baseUrl) : baseUrl,
      method: String(attrs.method || 'GET').toUpperCase(),
      id: attrs.id || '',
      className: attrs.class || '',
      fields,
      inputs,
    });
  }

  return forms;
}

export function findWordPressLoginForm(html = '', baseUrl = '') {
  return extractForms(html, baseUrl).find((form) => {
    const names = form.inputs.map((input) => input.name).join(' ');
    const types = form.inputs.map((input) => input.type).join(' ');
    return /\blog\b/.test(names) && /\bpwd\b/.test(names) || /\bpassword\b/i.test(types);
  }) || null;
}

export function parseActiveTheme(html = '') {
  const source = String(html || '');
  const divRe = /<div\b([^>]*)>/gi;
  let match;

  while ((match = divRe.exec(source))) {
    const attrs = parseAttributes(match[1]);
    const classes = attrs.class || '';
    if (!/\btheme\b/i.test(classes) || !/\bactive\b/i.test(classes)) continue;

    const block = source.slice(match.index, nextThemeBlockIndex(source, divRe.lastIndex));
    const nameMatch = block.match(/<h2\b[^>]*class=["'][^"']*\btheme-name\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
    const name = cleanText(nameMatch?.[1] || '');
    return {
      slug: attrs['data-slug'] || '',
      name: name.replace(/^active:\s*/i, ''),
      stylesheet: attrs['data-slug'] || '',
    };
  }

  return null;
}

export function parsePluginRows(html = '') {
  const plugins = [];
  const rowRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = rowRe.exec(String(html || '')))) {
    const attrs = parseAttributes(match[1]);
    if (!attrs['data-plugin'] && !attrs['data-slug']) continue;

    const block = match[2] || '';
    const nameMatch = block.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i);
    const classes = attrs.class || '';
    plugins.push({
      slug: attrs['data-slug'] || pluginSlugFromFile(attrs['data-plugin'] || ''),
      file: attrs['data-plugin'] || '',
      name: cleanText(nameMatch?.[1] || attrs['data-slug'] || attrs['data-plugin'] || ''),
      active: /\bactive\b/i.test(classes) && !/\binactive\b/i.test(classes),
    });
  }

  return plugins;
}

function compactPage(page = {}) {
  return {
    ok: Boolean(page.ok),
    status: page.status || 0,
    url: page.url || '',
    redirected: Boolean(page.redirected),
    redirects: Array.isArray(page.redirects) ? page.redirects : [],
  };
}

function resolveUrl(rawUrl, baseUrl = '') {
  if (!rawUrl && baseUrl) return normalizeWordPressEntryUrl(baseUrl);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(rawUrl || ''))) return normalizeWordPressEntryUrl(rawUrl);
  if (!baseUrl) return normalizeWordPressEntryUrl(rawUrl);
  return new URL(String(rawUrl || ''), normalizeWordPressEntryUrl(baseUrl)).toString();
}

function parseAttributes(source = '') {
  const attrs = {};
  const attrRe = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  let match;
  while ((match = attrRe.exec(String(source || '')))) {
    const key = match[1].toLowerCase();
    if (!key) continue;
    attrs[key] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function getSetCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const header = typeof headers.get === 'function' ? headers.get('set-cookie') : '';
  return splitSetCookieHeader(header);
}

function splitSetCookieHeader(header = '') {
  if (!header) return [];
  return String(header).split(/,\s*(?=[^;,=\s]+=[^;,]+)/g).map((value) => value.trim()).filter(Boolean);
}

function defaultCookiePath(pathname = '/') {
  const path = pathname || '/';
  if (!path.startsWith('/') || path === '/') return '/';
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index + 1);
}

function cookieKey(cookie) {
  return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

function domainMatches(hostname, domain, hostOnly) {
  const host = String(hostname || '').toLowerCase();
  const cookieDomain = String(domain || '').toLowerCase();
  if (hostOnly) return host === cookieDomain;
  return host === cookieDomain || host.endsWith(`.${cookieDomain}`);
}

function nextThemeBlockIndex(source, startIndex) {
  const next = source.slice(startIndex).search(/<div\b[^>]*class=["'][^"']*\btheme\b/i);
  return next === -1 ? Math.min(source.length, startIndex + 5000) : startIndex + next;
}

function pluginSlugFromFile(file = '') {
  return String(file || '').split('/')[0] || '';
}

function cleanText(html = '') {
  return decodeHtml(stripTags(html)).replace(/\s+/g, ' ').trim();
}

function stripTags(html = '') {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}
