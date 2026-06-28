const els = {
  status: document.getElementById('status'),
  thread: document.getElementById('thread'),
  message: document.getElementById('message'),
  send: document.getElementById('send'),
  attach: document.getElementById('attach'),
  imageInput: document.getElementById('image-input'),
  attachments: document.getElementById('attachments'),
};

const BRIDGE_URL = 'http://127.0.0.1:8792';
const BRIDGE_TOKEN = 'arafatai-local-token';
const MAX_AGENT_STEPS = 8;
const PLAN_POLL_INTERVAL_MS = 1500;
const MAX_PLAN_POLLS = 34;
const MAX_CODE_PLAN_POLLS = 56;
const POST_ACTION_SETTLE_MS = 900;
const NAVIGATION_SETTLE_TIMEOUT_MS = 7000;
const MANUAL_VERIFICATION_TIMEOUT_MS = 180000;
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MEMORY_STORAGE_KEY = 'aql_ai_sidebar_memory_v1';
const ASSISTANT_NAME = 'FLUID';

let history = [];
let conversationMemory = loadConversationMemory();
let pendingAttachments = [];
let activeTaskId = null;
let activeTraceGroup = null;
let activeTraceList = null;
let activeTaskOverview = null;
let activeTraceCount = 0;
let renderedTaskClassificationKey = '';
let renderedEvidenceKeys = new Set();

const TASK_OVERVIEW_FIELDS = [
  ['goal', 'Goal', 'Waiting for task'],
  ['mode', 'Mode', 'Unclassified'],
  ['risk', 'Risk gate', 'Safe'],
  ['evidence', 'Evidence', 'No evidence yet'],
  ['patch', 'Patch', 'No patch proposed'],
  ['verification', 'Verification', 'Not verified yet'],
  ['files', 'Files changed', 'None'],
  ['next', 'Next action', 'Starting'],
];

function scrollThreadToBottom() {
  requestAnimationFrame(() => {
    els.thread.scrollTop = els.thread.scrollHeight;
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'auto',
    });
  });
}

function focusMessageInput() {
  try {
    els.message.focus({ preventScroll: true });
  } catch {
    els.message.focus();
  }
}

function updateTraceSummary() {
  if (!activeTraceGroup) return;

  const count = activeTraceGroup.querySelector('.steps-count');
  const status = activeTraceGroup.querySelector('.steps-status');
  const hasThinking = Boolean(activeTraceGroup.querySelector('.trace.thinking'));
  const hasWarn = Boolean(activeTraceGroup.querySelector('.trace.warn'));
  const hasError = Boolean(activeTraceGroup.querySelector('.trace.error'));

  activeTraceGroup.classList.toggle('done', activeTraceCount > 0 && !hasThinking && !hasWarn && !hasError);
  activeTraceGroup.classList.toggle('warn', hasWarn && !hasError);
  activeTraceGroup.classList.toggle('error', hasError);

  if (count) {
    const label = activeTraceCount === 1 ? 'step' : 'steps';
    count.textContent = `${activeTraceCount} ${label}`;
  }

  if (status) {
    status.textContent = hasError ? 'Stopped' : hasThinking ? 'Working' : hasWarn ? 'Needs approval' : activeTraceCount ? 'Done' : '';
  }
}

function startTraceGroup() {
  const overview = createTaskOverview();
  const details = document.createElement('details');
  details.className = 'steps-panel';

  const summary = document.createElement('summary');
  const count = document.createElement('span');
  count.className = 'steps-count';
  const status = document.createElement('span');
  status.className = 'steps-status';
  summary.append(count, status);

  const list = document.createElement('div');
  list.className = 'steps-list';

  details.append(summary, list);
  els.thread.append(overview, details);

  activeTaskOverview = overview;
  activeTraceGroup = details;
  activeTraceList = list;
  activeTraceCount = 0;
  renderedTaskClassificationKey = '';
  renderedEvidenceKeys = new Set();
  updateTraceSummary();
  scrollThreadToBottom();
}

function ensureTraceGroup() {
  if (!activeTraceGroup || !activeTraceList) startTraceGroup();
  return activeTraceList;
}

function createTaskOverview() {
  const overview = document.createElement('article');
  overview.className = 'task-overview';
  overview.setAttribute('aria-label', 'Task overview');

  for (const [key, labelText, defaultValue] of TASK_OVERVIEW_FIELDS) {
    const row = document.createElement('div');
    row.className = 'task-overview-row';
    row.dataset.overviewRow = key;

    const label = document.createElement('span');
    label.className = 'task-overview-label';
    label.textContent = labelText;

    const value = document.createElement('span');
    value.className = 'task-overview-value muted';
    value.textContent = defaultValue;

    row.append(label, value);
    overview.append(row);
  }

  return overview;
}

function ensureTaskOverview() {
  if (!activeTaskOverview) startTraceGroup();
  return activeTaskOverview;
}

function safeOverviewTone(tone) {
  return ['ok', 'warn', 'error', 'muted'].includes(tone) ? tone : '';
}

function overviewCell(text, tone = '') {
  return { text, tone };
}

function setTaskOverviewValue(key, value) {
  if (value === undefined) return;
  const overview = ensureTaskOverview();
  const row = overview.querySelector(`[data-overview-row="${key}"]`);
  if (!row) return;

  const valueEl = row.querySelector('.task-overview-value');
  if (!valueEl) return;

  const nextValue = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { text: value };
  const text = shortenText(nextValue.text || '', 190);
  const tone = safeOverviewTone(nextValue.tone || '');
  valueEl.className = tone ? `task-overview-value ${tone}` : 'task-overview-value';
  valueEl.textContent = text || 'None';
}

function updateTaskOverview(values = {}) {
  if (!values || typeof values !== 'object') return;
  for (const [key, value] of Object.entries(values)) {
    setTaskOverviewValue(key, value);
  }
}

function setStatus(text, thinking = false) {
  els.status.textContent = text;
  els.status.classList?.toggle('thinking', thinking);
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function shortenText(text, limit = 500) {
  const value = normalizeText(text);
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function loadConversationMemory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MEMORY_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveConversationMemory() {
  try {
    localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(conversationMemory));
  } catch {
    // Memory is helpful context, but it should never block the chat UI.
  }
}

function memoryTurns() {
  return history.slice(-10).map((entry) => ({
    role: entry.role,
    text: shortenText(entry.text, 700),
    attachments: Array.isArray(entry.attachments) ? entry.attachments : [],
  }));
}

function normalizedMemoryHistory(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.slice(-10).filter((entry) => entry && typeof entry === 'object').map((entry) => ({
    role: entry.role === 'assistant' ? 'assistant' : 'user',
    text: shortenText(entry.text, 700),
    attachments: Array.isArray(entry.attachments) ? entry.attachments : [],
  }));
}

function summarizeTurns(turns) {
  return turns
    .slice(-8)
    .map((entry) => `${entry.role === 'assistant' ? ASSISTANT_NAME : 'User'}: ${shortenText(entry.text, 220)}`)
    .filter((line) => line.trim().length > 8)
    .join('\n');
}

function syncConversationMemory() {
  const turns = memoryTurns();
  conversationMemory = {
    ...conversationMemory,
    summary: summarizeTurns(turns),
    recent_turns: turns,
    updated_at: new Date().toISOString(),
  };
  saveConversationMemory();
}

function rememberObservedPage(page) {
  if (!page?.url && !page?.title) return;
  conversationMemory = {
    ...conversationMemory,
    last_page: {
      url: page.url || '',
      title: page.title || '',
      visible_text_sample: shortenText(page.visible_text, 500),
      captured_at: page.captured_at || new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };
  saveConversationMemory();
}

function rememberTaskResult(goal, reply, status = 'done') {
  conversationMemory = {
    ...conversationMemory,
    last_task: {
      goal: shortenText(goal, 700),
      reply: shortenText(reply, 900),
      status,
      task_id: activeTaskId || '',
      finished_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };
  syncConversationMemory();
}

function conversationMemoryPayload() {
  return {
    summary: conversationMemory.summary || '',
    recent_turns: Array.isArray(conversationMemory.recent_turns) ? conversationMemory.recent_turns.slice(-10) : [],
    last_page: conversationMemory.last_page || null,
    last_task: conversationMemory.last_task || null,
    updated_at: conversationMemory.updated_at || '',
  };
}

history = normalizedMemoryHistory(conversationMemory.recent_turns);

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function appendTextWithPrettyLinks(container, text) {
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  let lastIndex = 0;
  let match = urlPattern.exec(text);

  while (match) {
    const rawMatch = match[0];
    let url = rawMatch;
    let trailing = '';

    while (/[),.;:!?]$/.test(url)) {
      trailing = `${url.slice(-1)}${trailing}`;
      url = url.slice(0, -1);
    }

    container.append(document.createTextNode(text.slice(lastIndex, match.index)));

    const anchor = document.createElement('a');
    anchor.className = 'inline-link';
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.title = url;
    anchor.textContent = compactUrlLabel(url);
    container.append(anchor);

    if (trailing) container.append(document.createTextNode(trailing));
    lastIndex = match.index + rawMatch.length;
    match = urlPattern.exec(text);
  }

  container.append(document.createTextNode(text.slice(lastIndex)));
}

function appendParagraph(container, lines) {
  const text = lines.join('\n').trim();
  if (!text) return;
  const paragraph = document.createElement('p');
  appendTextWithPrettyLinks(paragraph, text);
  container.append(paragraph);
}

function appendList(container, items, ordered = false) {
  if (!items.length) return;
  const list = document.createElement(ordered ? 'ol' : 'ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    list.append(li);
  }
  container.append(list);
}

function codeLanguageLabel(language) {
  const normalized = String(language || '').trim().toLowerCase();
  const labels = {
    bash: 'Shell',
    css: 'CSS',
    html: 'HTML',
    javascript: 'JavaScript',
    js: 'JavaScript',
    json: 'JSON',
    jsx: 'JSX',
    php: 'PHP',
    powershell: 'PowerShell',
    ps1: 'PowerShell',
    sh: 'Shell',
    shell: 'Shell',
    text: 'Text',
    ts: 'TypeScript',
    tsx: 'TSX',
    typescript: 'TypeScript',
    xml: 'XML',
  };
  return labels[normalized] || normalized.toUpperCase() || 'Code';
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function appendCodeToken(container, className, text) {
  if (!text) return;
  if (!className) {
    container.append(document.createTextNode(text));
    return;
  }

  const token = document.createElement('span');
  token.className = `code-token ${className}`;
  token.textContent = text;
  container.append(token);
}

function codeTokenClass(token, language) {
  if (/^\/\*[\s\S]*\*\/$/.test(token)
    || /^\/\/[^\n]*$/.test(token)
    || (/^#[^\n]*$/.test(token) && /^(bash|sh|shell|powershell|ps1)$/i.test(language))) {
    return 'comment';
  }
  if (/^["'`]/.test(token)) return 'string';
  if (/^\b\d+(?:\.\d+)?\b$/.test(token)) return 'number';
  if (/^(true|false|null|undefined)$/i.test(token)) return 'literal';
  if (/^(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|new|try|catch|finally|throw|async|await|import|export|from|default|extends|this|typeof|instanceof|in|of|echo|cd|dir|ls|npm|node|git|where|select|string|public|private|protected|static|namespace|use|array|object)$/i.test(token)) {
    return 'keyword';
  }
  if (/^(document|window|chrome|jQuery|\$|console|Promise|Array|Object|String|Number|Boolean|JSON|Date|Get-ChildItem|Select-String|Set-Location|Write-Host)$/i.test(token)) {
    return 'builtin';
  }
  if (/^[{}()[\].,;:+\-*/%=<>!&|?]+$/.test(token)) return 'operator';
  return '';
}

function appendHighlightedCode(codeElement, code, language) {
  const normalizedLanguage = String(language || '').trim().toLowerCase();
  if (code.length > 50000) {
    codeElement.textContent = code;
    return;
  }

  const commentPattern = /^(bash|sh|shell|powershell|ps1)$/i.test(normalizedLanguage)
    ? String.raw`#[^\n]*`
    : String.raw`\/\*[\s\S]*?\*\/|\/\/[^\n]*`;
  const tokenPattern = new RegExp(
    `${commentPattern}|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`|\\b[A-Za-z_$][\\w$-]*\\b|\\b\\d+(?:\\.\\d+)?\\b|[{}()[\\].,;:+\\-*/%=<>!&|?]+`,
    'g',
  );

  let lastIndex = 0;
  let match = tokenPattern.exec(code);
  while (match) {
    appendCodeToken(codeElement, '', code.slice(lastIndex, match.index));
    appendCodeToken(codeElement, codeTokenClass(match[0], normalizedLanguage), match[0]);
    lastIndex = tokenPattern.lastIndex;
    match = tokenPattern.exec(code);
  }
  appendCodeToken(codeElement, '', code.slice(lastIndex));
}

function appendCodeBlock(container, lines, language = '') {
  const code = lines.join('\n').replace(/\n+$/g, '');
  if (!code) return;

  const shell = document.createElement('figure');
  shell.className = 'code-shell';

  const header = document.createElement('figcaption');
  header.className = 'code-shell-header';

  const label = document.createElement('span');
  label.className = 'code-shell-language';
  label.textContent = codeLanguageLabel(language);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'code-copy-button';
  copy.textContent = 'Copy';
  copy.setAttribute('aria-label', `Copy ${label.textContent} code`);
  copy.addEventListener('click', async () => {
    copy.disabled = true;
    try {
      await copyTextToClipboard(code);
      copy.textContent = 'Copied';
      setTimeout(() => {
        copy.textContent = 'Copy';
        copy.disabled = false;
      }, 1300);
    } catch {
      copy.textContent = 'Failed';
      setTimeout(() => {
        copy.textContent = 'Copy';
        copy.disabled = false;
      }, 1300);
    }
  });

  header.append(label, copy);

  const pre = document.createElement('pre');
  const codeElement = document.createElement('code');
  if (language) codeElement.className = `language-${language.replace(/[^a-z0-9_-]/gi, '')}`;
  appendHighlightedCode(codeElement, code, language);
  pre.append(codeElement);
  shell.append(header, pre);
  container.append(shell);
}

function commaListFromLine(line) {
  const match = /^(.{8,180}?:)\s+(.+)$/.exec(line);
  if (!match) return null;
  const rawItems = match[2].split(',').map((item) => item.trim()).filter(Boolean);
  const shortItems = rawItems.filter((item) => item.length <= 60);
  if (rawItems.length < 4 || shortItems.length !== rawItems.length) return null;
  if (/https?:\/\//i.test(match[2])) return null;
  return { lead: match[1], items: rawItems };
}

function renderRichText(container, text) {
  const lines = String(text || '(empty)').split(/\r?\n/);
  let paragraphLines = [];
  let listItems = [];
  let orderedItems = [];
  let codeLines = [];
  let codeLanguage = '';
  let inCodeBlock = false;

  function flushParagraph() {
    appendParagraph(container, paragraphLines);
    paragraphLines = [];
  }

  function flushLists() {
    appendList(container, listItems, false);
    appendList(container, orderedItems, true);
    listItems = [];
    orderedItems = [];
  }

  for (const rawLine of lines) {
    const fence = rawLine.trim().match(/^```([a-z0-9_-]*)\s*$/i);
    if (fence) {
      if (inCodeBlock) {
        appendCodeBlock(container, codeLines, codeLanguage);
        codeLines = [];
        codeLanguage = '';
        inCodeBlock = false;
      } else {
        flushParagraph();
        flushLists();
        codeLanguage = fence[1] || '';
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushLists();
      continue;
    }

    const commaList = commaListFromLine(line);
    if (commaList) {
      flushParagraph();
      flushLists();
      appendParagraph(container, [commaList.lead]);
      appendList(container, commaList.items, false);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (orderedItems.length) flushLists();
      listItems.push(bullet[1]);
      continue;
    }

    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (listItems.length) flushLists();
      orderedItems.push(ordered[1]);
      continue;
    }

    flushLists();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushLists();
  if (inCodeBlock) appendCodeBlock(container, codeLines, codeLanguage);
}

function renderMessageAttachments(article, attachments = [], removable = false) {
  if (!attachments.length) return;
  const list = document.createElement('div');
  list.className = 'message-attachments';

  attachments.forEach((attachment, index) => {
    const item = document.createElement('figure');
    item.className = 'message-attachment';

    const img = document.createElement('img');
    img.src = attachment.preview_url || attachment.data_url || '';
    img.alt = attachment.name || `Uploaded image ${index + 1}`;

    const caption = document.createElement('figcaption');
    caption.textContent = `${index + 1}. ${attachment.name || 'Image'}`;

    item.append(img, caption);

    if (removable) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${attachment.name || `image ${index + 1}`}`);
      remove.textContent = 'x';
      remove.addEventListener('click', () => {
        pendingAttachments = pendingAttachments.filter((entry) => entry.id !== attachment.id);
        renderPendingAttachments();
        focusMessageInput();
      });
      item.append(remove);
    }

    list.append(item);
  });

  article.append(list);
}

function compactAttachmentForHistory(attachment, index) {
  return {
    order: attachment.order || index + 1,
    source: attachment.source || 'user-upload',
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
  };
}

function attachmentPayload(attachments) {
  return attachments.map((attachment, index) => ({
    id: attachment.id,
    order: index + 1,
    name: attachment.name,
    source: attachment.source || 'user-upload',
    type: attachment.type,
    size: attachment.size,
    data_url: attachment.data_url,
  }));
}

function renderPendingAttachments() {
  els.attachments.replaceChildren();
  els.attachments.hidden = pendingAttachments.length === 0;
  renderMessageAttachments(els.attachments, pendingAttachments, true);
}

function addMessage(role, text, attachments = []) {
  const article = document.createElement('article');
  article.className = `message ${role}`;

  const name = document.createElement('span');
  name.textContent = role === 'user' ? 'You' : ASSISTANT_NAME;

  const body = document.createElement('div');
  body.className = 'message-body';
  if (role === 'assistant') {
    renderRichText(body, text || '(empty)');
  } else {
    const paragraph = document.createElement('p');
    paragraph.textContent = text || (attachments.length ? 'Uploaded image' : '(empty)');
    body.append(paragraph);
  }

  article.append(name, body);
  renderMessageAttachments(article, attachments);
  els.thread.append(article);
  scrollThreadToBottom();

  history.push({
    role,
    text: text || '',
    attachments: attachments.map(compactAttachmentForHistory),
  });
  history = history.slice(-10);
  syncConversationMemory();
}

function screenshotPolicyForGoal(goal) {
  const text = normalizeText(goal).toLowerCase();
  const asksToShowScreenshot = /\b(screenshot|screen shot|screen capture)\b/.test(text)
    && /\b(show|open|display|preview|dekhao|dekhan|dekhaw|dekhte chai)\b/.test(text);
  const asksVisualQuestion = /\b(screenshot|screen shot|image|photo|picture|visual|screen|ui|visible|dekho|dekhe|kothay|where)\b/.test(text);
  const asksBrowserAction = /\b(click|press|type|input|fill|select|choose|open|navigate|go|jao|dhuko|tab|scroll|console|error|issue|problem|button|check|inspect)\b/.test(text);

  return {
    capture: asksVisualQuestion || asksBrowserAction,
    show: asksToShowScreenshot,
  };
}

function plannerPollLimitForGoal(goal) {
  const text = normalizeText(goal).toLowerCase();
  const asksForCode = /\b(code|script|css|js|php|snippet|fixing|fix|exact|implementation|implement|shell)\b/.test(text);
  return asksForCode ? MAX_CODE_PLAN_POLLS : MAX_PLAN_POLLS;
}

function addSnapshotCard(page, screenshot, step) {
  if (!screenshot?.preview_url) return;

  const article = document.createElement('article');
  article.className = 'snapshot-card';

  const header = document.createElement('div');
  header.className = 'snapshot-card-header';

  const title = document.createElement('span');
  title.textContent = `Screenshot ${step}`;

  const meta = document.createElement('span');
  meta.textContent = page?.title || page?.url || 'current tab';

  header.append(title, meta);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'snapshot-card-image';
  button.setAttribute('aria-label', `Open screenshot ${step}`);

  const image = document.createElement('img');
  image.src = screenshot.preview_url;
  image.alt = `Screenshot ${step} of ${page?.title || page?.url || 'current tab'}`;

  button.append(image);
  button.addEventListener('click', () => {
    window.open(screenshot.preview_url, '_blank', 'noopener,noreferrer');
  });

  article.append(header, button);
  els.thread.append(article);
  scrollThreadToBottom();
}

function addTrace(text, detail = '', state = '', labelText = '') {
  const traceList = ensureTraceGroup();
  const article = document.createElement('article');
  article.className = state ? `trace ${state}` : 'trace';

  const label = document.createElement('span');
  label.textContent = labelText || (state === 'thinking' ? 'Working' : 'Trace');

  const body = document.createElement('p');
  body.textContent = detail ? `${text}\n${detail}` : text;

  article.append(label, body);
  traceList.append(article);
  activeTraceCount += 1;
  updateTraceSummary();
  scrollThreadToBottom();
  return article;
}

function setTraceState(article, state = '') {
  if (!article) return;

  article.classList.remove('thinking', 'done', 'error');
  if (state) article.classList.add(state);

  const label = article.querySelector('span');
  if (label) {
    label.textContent = state === 'thinking'
      ? 'Working'
      : state === 'done'
        ? 'Done'
        : state === 'error'
          ? 'Stopped'
          : 'Trace';
  }
  updateTraceSummary();
}

function setTraceText(article, text, detail = '') {
  if (!article) return;

  const body = article.querySelector('p');
  if (body) {
    body.textContent = detail ? `${text}\n${detail}` : text;
  }
  updateTraceSummary();
  scrollThreadToBottom();
}

function clearThinkingTraces(state = 'done') {
  els.thread.querySelectorAll('.trace.thinking').forEach((trace) => {
    setTraceState(trace, state);
  });
  updateTraceSummary();
}

function humanizeToken(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function classificationTraceKey(classification) {
  if (!classification || typeof classification !== 'object') return '';
  return [
    classification.task_type || '',
    classification.domain || '',
    classification.risk_level || '',
    Array.isArray(classification.evidence_needed) ? classification.evidence_needed.join(',') : '',
  ].join('|');
}

function renderTaskClassification(classification) {
  if (!classification || typeof classification !== 'object') return;

  const key = classificationTraceKey(classification);
  if (!key || key === renderedTaskClassificationKey) return;
  renderedTaskClassificationKey = key;

  const mode = humanizeToken(classification.task_type || 'unknown');
  const domain = humanizeToken(classification.domain || 'unknown');
  const risk = humanizeToken(classification.risk_level || 'safe');
  const evidence = Array.isArray(classification.evidence_needed)
    ? classification.evidence_needed.map(humanizeToken).filter(Boolean).join(', ')
    : '';
  const detail = [
    `Domain: ${domain}. Risk: ${risk}.`,
    evidence ? `Evidence needed: ${evidence}.` : '',
    classification.reason ? `Reason: ${classification.reason}` : '',
  ].filter(Boolean).join('\n');

  addTrace(`Mode selected: ${mode}.`, detail, '', 'Mode');
}

function evidenceTraceKey(item) {
  if (!item || typeof item !== 'object') return '';
  return item.path || [item.type || '', item.title || '', item.created_at || ''].join('|');
}

function evidenceText(item) {
  if (!item || typeof item !== 'object') return '';
  return [item.title, item.summary, item.type].filter(Boolean).join(' ');
}

function evidenceTone(item) {
  const text = evidenceText(item);
  if (/blocked|denied|needs approval|not allowed|failed|error|timeout|exited with [1-9]/i.test(text)) return 'error';
  if (/warn|manual|skipped|pending|needs user|needs review/i.test(text)) return 'thinking';
  if (/passed|verified|completed|success|ok|active theme|plugin rows|assertion passed/i.test(text)) return 'done';
  return '';
}

function overviewToneFromEvidence(item) {
  const tone = evidenceTone(item);
  if (tone === 'done') return 'ok';
  if (tone === 'thinking') return 'warn';
  if (tone === 'error') return 'error';
  return '';
}

function evidenceBucket(item) {
  const type = String(item?.type || '').toLowerCase();
  const text = evidenceText(item);

  if (type === 'tool_blocked' || /tool blocked|blocked by policy|needs approval/i.test(text)) {
    return { label: 'Risk gate', tone: 'warn' };
  }

  if (/^patch_/i.test(type) || /patch|file change/i.test(text)) {
    return { label: 'Patch', tone: evidenceTone(item) };
  }

  if (
    /browser_verification|patch_check|http|wordpress|test|lint/i.test(type) ||
    /assertion|verified|check|lint|active theme|plugin rows/i.test(text)
  ) {
    return { label: 'Verification', tone: evidenceTone(item) };
  }

  return { label: 'Evidence', tone: evidenceTone(item) };
}

function evidenceDisplayTitle(item) {
  const type = String(item?.type || '').toLowerCase();
  const title = item?.title || humanizeToken(item?.type || 'Evidence');
  const summary = item?.summary || '';

  if (type === 'browser_verification') {
    if (/assertion passed/i.test(summary)) return `Browser check passed: ${title}`;
    if (/assertion failed|failed|error/i.test(summary)) return `Browser check failed: ${title}`;
    return `Browser check: ${title}`;
  }

  if (type === 'patch_check') return `Patch check: ${title}`;
  if (type === 'tool_blocked') return `Blocked: ${title}`;
  return title;
}

function renderTaskEvidence(task) {
  const evidence = Array.isArray(task?.evidence) ? task.evidence : [];
  for (const item of evidence) {
    const key = evidenceTraceKey(item);
    if (!key || renderedEvidenceKeys.has(key)) continue;
    renderedEvidenceKeys.add(key);

    const bucket = evidenceBucket(item);
    const title = evidenceDisplayTitle(item);
    const detail = [
      item.type ? `Type: ${humanizeToken(item.type)}.` : '',
      item.summary || '',
      item.path ? `Path: ${item.path}` : '',
    ].filter(Boolean).join('\n');

    addTrace(`${bucket.label} logged: ${title}.`, detail, bucket.tone, bucket.label);
  }
}

function overviewClassification(classification) {
  if (!classification || typeof classification !== 'object') {
    return {
      mode: overviewCell('Unclassified', 'muted'),
      risk: overviewCell('Safe', 'ok'),
    };
  }

  const mode = humanizeToken(classification.task_type || 'unknown');
  const domain = humanizeToken(classification.domain || 'unknown');
  const risk = String(classification.risk_level || 'safe').toLowerCase();
  const needed = Array.isArray(classification.evidence_needed)
    ? classification.evidence_needed.map(humanizeToken).filter(Boolean)
    : [];
  const riskText = [
    humanizeToken(risk || 'safe'),
    needed.length ? `needs ${needed.slice(0, 3).join(', ')}` : '',
  ].filter(Boolean).join('; ');
  const riskTone = risk === 'safe' || risk === 'low' ? 'ok' : risk.includes('block') || risk.includes('destructive') ? 'error' : 'warn';

  return {
    mode: overviewCell(`${mode} / ${domain}`, ''),
    risk: overviewCell(riskText || 'Safe', riskTone),
  };
}

function summarizeRiskForOverview(classification, evidence) {
  const blocked = latestMatchingEvidence(evidence, (item) => {
    const type = String(item?.type || '').toLowerCase();
    return type === 'tool_blocked' || /tool blocked|blocked by policy|needs approval/i.test(evidenceText(item));
  });
  if (blocked) {
    return overviewCell(blocked.summary || blocked.title || 'Tool blocked until approval', 'error');
  }
  return overviewClassification(classification).risk;
}

function latestMatchingEvidence(evidence, matcher) {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    if (matcher(evidence[index])) return evidence[index];
  }
  return null;
}

function summarizeEvidenceForOverview(evidence) {
  if (!evidence.length) return overviewCell('No evidence yet', 'muted');
  const latest = evidence
    .slice(-2)
    .map((item) => item.title || humanizeToken(item.type || 'Evidence'))
    .filter(Boolean);
  return overviewCell(`${evidence.length} logged${latest.length ? `: ${latest.join(' | ')}` : ''}.`, '');
}

function summarizePatchForOverview(evidence) {
  const patch = latestMatchingEvidence(evidence, (item) => /^patch_/i.test(item?.type || '') || /file change|patch/i.test(evidenceText(item)));
  if (!patch) return overviewCell('No patch proposed', 'muted');
  const tone = patch.type === 'patch_apply' ? 'ok' : patch.type === 'patch_check' ? overviewToneFromEvidence(patch) || 'warn' : overviewToneFromEvidence(patch);
  return overviewCell(patch.summary || patch.title || 'Patch evidence logged', tone);
}

function summarizeVerificationForOverview(evidence) {
  const verification = latestMatchingEvidence(evidence, (item) => (
    /browser_verification|patch_check|http|wordpress|test|lint/i.test(item?.type || '') ||
    /assertion|verified|check|lint|active theme|plugin rows/i.test(evidenceText(item))
  ));
  if (!verification) return overviewCell('Not verified yet', 'muted');
  const type = String(verification.type || '').toLowerCase();
  const summary = verification.summary || verification.title || 'Verification evidence logged';
  const tone = overviewToneFromEvidence(verification) || 'ok';
  if (type === 'browser_verification') {
    if (/assertion passed/i.test(summary)) return overviewCell(`Browser check passed: ${shortenText(summary, 120)}`, tone);
    if (/assertion failed|failed|error/i.test(summary)) return overviewCell(`Browser check failed: ${shortenText(summary, 120)}`, 'error');
    return overviewCell(`Browser check logged: ${shortenText(summary, 120)}`, tone);
  }
  return overviewCell(summary, tone);
}

function summarizeFilesForOverview(evidence) {
  const fileEvidence = evidence.filter((item) => /^patch_/i.test(item?.type || ''));
  const files = [];

  for (const item of fileEvidence) {
    const text = item.summary || '';
    const match = text.match(/\b(?:for|to)\s+([^.;]+?)(?:\.|;|$)/i);
    if (match?.[1]) files.push(match[1].trim());
  }

  const uniqueFiles = [...new Set(files)].filter(Boolean);
  if (!uniqueFiles.length) return overviewCell('None', 'muted');
  return overviewCell(uniqueFiles.slice(-2).join(' | '), '');
}

function updateTaskOverviewFromTask(task) {
  const evidence = Array.isArray(task?.evidence) ? task.evidence : [];
  const classification = overviewClassification(task?.task_classification);
  updateTaskOverview({
    goal: task?.goal ? shortenText(task.goal, 190) : undefined,
    mode: classification.mode,
    risk: summarizeRiskForOverview(task?.task_classification, evidence),
    evidence: summarizeEvidenceForOverview(evidence),
    patch: summarizePatchForOverview(evidence),
    verification: summarizeVerificationForOverview(evidence),
    files: summarizeFilesForOverview(evidence),
  });
}

function updateTaskOverviewFromAgentReply(agentReply) {
  if (!agentReply || typeof agentReply !== 'object') return;

  if (Array.isArray(agentReply.questions) && agentReply.questions.length) {
    updateTaskOverview({
      next: overviewCell(`Waiting for answer: ${agentReply.questions[0]}`, 'warn'),
      risk: overviewCell(agentReply.needs_approval ? 'Needs approval' : 'Needs user input', 'warn'),
    });
    return;
  }

  if (agentReply.needs_approval) {
    updateTaskOverview({
      next: overviewCell('Waiting for approval', 'warn'),
      risk: overviewCell('Needs approval before continuing', 'warn'),
    });
    return;
  }

  if (agentReply.done) {
    updateTaskOverview({
      next: overviewCell('Done', 'ok'),
    });
    return;
  }

  const actions = Array.isArray(agentReply.actions) ? agentReply.actions : [];
  if (actions.length) {
    updateTaskOverview({
      next: overviewCell(formatAction(actions[0]), ''),
    });
    return;
  }

  updateTaskOverview({
    next: overviewCell('No next action returned', 'warn'),
  });
}

function updateTaskOverviewFromActionResult(result) {
  if (!result || typeof result !== 'object') return;
  updateTaskOverview({
    next: overviewCell(result.ok ? 'Action completed' : 'Action blocked or failed', result.ok ? 'ok' : 'error'),
    verification: overviewCell(result.message || (result.ok ? 'Last action completed' : 'Last action failed'), result.ok ? 'ok' : 'error'),
  });
}

function renderTaskTelemetry(task) {
  updateTaskOverviewFromTask(task);
  renderTaskClassification(task?.task_classification);
  renderTaskEvidence(task);
}

function formatAction(action) {
  const type = String(action?.type || 'action');
  if (isBridgeToolAction(action)) {
    const tool = normalizeText(action?.tool || action?.name || action?.target || '');
    return tool ? `${type}: ${tool}` : type;
  }
  const target = normalizeText(action?.target || action?.value || action?.url || '');
  return target ? `${type}: ${target}` : type;
}

function normalizeAgentAction(action) {
  const next = { ...(action || {}) };
  const target = normalizeText(next.target || '');
  const value = normalizeText(next.value || next.text || next.label || '');
  const genericClickTarget = /^(a|button|input|textarea|select|\[role=["']?button["']?\])$/i.test(target);

  if (next.type === 'click' && genericClickTarget && value) {
    next.target = `text=${value}`;
    next.normalized_from = target;
  }

  return next;
}

function isBridgeToolAction(action) {
  const type = String(action?.type || '').toLowerCase();
  return type === 'tool' || type === 'run_tool';
}

function parseToolInput(action) {
  if (action?.input && typeof action.input === 'object' && !Array.isArray(action.input)) return action.input;
  if (action?.args && typeof action.args === 'object' && !Array.isArray(action.args)) return action.args;

  const raw = action?.input || action?.args || action?.value || '';
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function runBridgeToolAction(action) {
  if (!activeTaskId) {
    return {
      ok: false,
      message: 'Tool action needs an active task checkpoint.',
      action,
    };
  }

  const tool = normalizeText(action.tool || action.name || action.target || '');
  if (!tool) {
    return {
      ok: false,
      message: 'Tool action did not specify a tool name.',
      action,
    };
  }

  try {
    const data = await bridgePost(`/tasks/${activeTaskId}/tool`, {
      tool,
      input: parseToolInput(action),
    });
    if (data.task) renderTaskTelemetry(data.task);
    const evidence = data.evidence || {};
    const evidenceText = [evidence.title, evidence.summary].filter(Boolean).join('. ');
    return {
      ok: data.ok !== false,
      message: evidenceText || `Tool ${tool} completed.`,
      action,
      result: data.result || null,
      task: data.task || null,
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || `Tool ${tool} failed.`,
      action,
    };
  }
}

function renderReasoning(agentReply, source) {
  const lines = [];
  if (source) lines.push(`Planner source: ${source}`);
  if (Array.isArray(agentReply.reasoning_summary)) {
    lines.push(...agentReply.reasoning_summary.filter(Boolean).map((item) => `- ${item}`));
  }
  if (lines.length) addTrace('Reasoning summary', lines.join('\n'));
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function taskTab(tab = null) {
  if (tab?.id) {
    try {
      return await chrome.tabs.get(tab.id);
    } catch {
      return null;
    }
  }
  return activeTab();
}

async function focusTaskTab(tab = null) {
  const current = await taskTab(tab);
  if (!current?.id) return current;

  try {
    if (current.windowId) await chrome.windows.update(current.windowId, { focused: true });
  } catch {
    // Window focus is best effort; tab activation is enough for extension APIs.
  }

  try {
    await chrome.tabs.update(current.id, { active: true });
    return await chrome.tabs.get(current.id);
  } catch {
    return current;
  }
}

function isMissingContentScriptError(error) {
  const message = error?.message || String(error || '');
  return message.includes('Receiving end does not exist') || message.includes('Could not establish connection');
}

function isScriptableTab(tab) {
  return /^https?:\/\//.test(tab?.url || '') || /^file:\/\//.test(tab?.url || '');
}

function fallbackTabSnapshot(tab) {
  return {
    url: tab?.url || '',
    title: tab?.title || '',
    visible_text: tab?.url?.startsWith('chrome://')
      ? 'Chrome internal page. The extension cannot inspect this page DOM, but it can navigate the tab.'
      : '',
    clickables: [],
    forms: [],
    dialogs: [],
    captured_at: new Date().toISOString(),
  };
}

function isManualVerificationPage(page = {}) {
  const url = String(page.url || '').toLowerCase();
  const title = normalizeText(page.title || '').toLowerCase();
  const text = normalizeText(page.visible_text || '').toLowerCase();
  const haystack = `${url} ${title} ${text}`;

  return url.includes('google.com/sorry/')
    || url.includes('/sorry/index')
    || haystack.includes('unusual traffic')
    || haystack.includes("i'm not a robot")
    || haystack.includes('i am not a robot')
    || haystack.includes('recaptcha')
    || haystack.includes('not a robot');
}

async function sendTabMessageWithInjection(tab, message) {
  if (!tab?.id || !isScriptableTab(tab)) {
    throw new Error('Current tab cannot be controlled with page DOM actions.');
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!isMissingContentScriptError(error)) throw error;

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function optionalPageSnapshot(tab = null) {
  const current = await focusTaskTab(tab);
  const tabForSnapshot = current || await activeTab();
  if (!tabForSnapshot?.id || !isScriptableTab(tabForSnapshot)) return fallbackTabSnapshot(tabForSnapshot);

  try {
    const response = await sendTabMessageWithInjection(tabForSnapshot, { type: 'ARAFATAI_SNAPSHOT' });
    return response?.ok ? response.snapshot : fallbackTabSnapshot(tabForSnapshot);
  } catch {
    return fallbackTabSnapshot(tabForSnapshot);
  }
}

async function captureCurrentScreenshot(step, tab = null) {
  const current = await focusTaskTab(tab);
  const tabForScreenshot = current || await activeTab();
  if (!tabForScreenshot?.windowId || !isScriptableTab(tabForScreenshot)) return null;

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tabForScreenshot.windowId, {
      format: 'jpeg',
      quality: 72,
    });
    if (!dataUrl) return null;
    return {
      id: `screenshot-${Date.now()}-${step}`,
      order: step,
      source: 'current-tab-screenshot',
      name: `current-tab-step-${step}.jpg`,
      type: 'image/jpeg',
      size: Math.round((dataUrl.length * 3) / 4),
      data_url: dataUrl,
      preview_url: dataUrl,
    };
  } catch (error) {
    addTrace('Screenshot capture skipped.', error.message || String(error), 'error');
    return null;
  }
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{')) return trimmed;

  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  if (candidate.startsWith('{')) return candidate;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return candidate.slice(start, end + 1);
}

function normalizeAgentReplyData(data) {
  return {
    reply: String(data?.reply || data?.answer || ''),
    reasoning_summary: Array.isArray(data?.reasoning_summary) ? data.reasoning_summary : [],
    questions: Array.isArray(data?.questions) ? data.questions : [],
    actions: Array.isArray(data?.actions) ? data.actions : [],
    done: Boolean(data?.done),
    needs_approval: Boolean(data?.needs_approval),
  };
}

function decodeLooseJsonString(value) {
  const text = String(value || '');
  try {
    return JSON.parse(`"${text.replace(/\r?\n/g, '\\n')}"`);
  } catch {
    return text
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\\\/g, '\\');
  }
}

function extractLooseStringProperty(jsonText, property) {
  const pattern = new RegExp(`"${property}"\\s*:\\s*"`);
  const match = pattern.exec(jsonText);
  if (!match) return '';

  const start = match.index + match[0].length;
  const after = jsonText.slice(start);
  const delimiters = [
    '"reasoning_summary"',
    '"questions"',
    '"actions"',
    '"done"',
    '"needs_approval"',
  ];
  const delimiterIndexes = delimiters
    .map((delimiter) => after.indexOf(`",${delimiter}`))
    .filter((index) => index >= 0);
  const end = delimiterIndexes.length ? Math.min(...delimiterIndexes) : after.lastIndexOf('"');

  return end >= 0 ? decodeLooseJsonString(after.slice(0, end)) : '';
}

function extractJsonSection(jsonText, property, opener, closer) {
  const pattern = new RegExp(`"${property}"\\s*:\\s*\\${opener}`);
  const match = pattern.exec(jsonText);
  if (!match) return '';

  const start = match.index + match[0].lastIndexOf(opener);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < jsonText.length; index += 1) {
    const char = jsonText[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === opener) depth += 1;
    if (char === closer) depth -= 1;
    if (depth === 0) return jsonText.slice(start, index + 1);
  }

  return '';
}

function extractLooseArrayProperty(jsonText, property) {
  const section = extractJsonSection(jsonText, property, '[', ']');
  if (!section) return [];
  try {
    const parsed = JSON.parse(section);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseLooseAgentReply(jsonText) {
  const reply = extractLooseStringProperty(jsonText, 'reply');
  if (!reply) return null;

  return normalizeAgentReplyData({
    reply,
    reasoning_summary: extractLooseArrayProperty(jsonText, 'reasoning_summary'),
    questions: extractLooseArrayProperty(jsonText, 'questions'),
    actions: extractLooseArrayProperty(jsonText, 'actions'),
    done: /"done"\s*:\s*true\b/.test(jsonText),
    needs_approval: /"needs_approval"\s*:\s*true\b/.test(jsonText),
  });
}

function parseAgentReply(text) {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return {
      reply: String(text || ''),
      reasoning_summary: [],
      questions: [],
      actions: [],
      done: false,
      needs_approval: false,
    };
  }

  try {
    const data = JSON.parse(jsonText);
    return normalizeAgentReplyData(data);
  } catch {
    const looseReply = parseLooseAgentReply(jsonText);
    if (looseReply) return looseReply;

    return {
      reply: String(text || ''),
      reasoning_summary: [],
      questions: [],
      actions: [],
      done: false,
      needs_approval: false,
    };
  }
}

function compactUrlLabel(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const host = url.hostname.replace(/^www\./i, '');
    const path = url.pathname.replace(/\/$/, '');

    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
      if (path === '/results') {
        const query = normalizeText(url.searchParams.get('search_query') || url.searchParams.get('q') || '');
        return query ? `YouTube search: ${query}` : 'YouTube search results';
      }
      if (path === '/watch' || host === 'youtu.be') return 'YouTube video';
      return `YouTube${path ? ` ${path}` : ''}`;
    }

    if (host === 'google.com' || host.endsWith('.google.com')) {
      if (path === '/search') {
        const query = normalizeText(url.searchParams.get('q') || '');
        return query ? `Google search: ${query}` : 'Google search results';
      }
      return `Google${path ? ` ${path}` : ''}`;
    }

    return `${host}${path || '/'}`;
  } catch {
    return shortenText(rawUrl, 90);
  }
}

function formatOpenedMessage(url) {
  return `Opened: ${compactUrlLabel(url)}`;
}

function isLowValueObservation(message) {
  return /^(Observed current page\.|Observed [^.]+\.|Waited \d+ms\.|(click|type|press) completed\.|Opened: .+)$/i.test(message);
}

function readableReply(agentReply, observations = []) {
  const lines = [];
  const seenObservations = new Set();
  const uniqueObservations = [];

  for (const item of observations) {
    const message = normalizeText(item?.message || '');
    if (!message || seenObservations.has(message)) continue;
    if (agentReply.reply && isLowValueObservation(message)) continue;
    seenObservations.add(message);
    uniqueObservations.push(item);
  }

  if (agentReply.reply) lines.push(agentReply.reply);
  if (Array.isArray(agentReply.questions) && agentReply.questions.length) {
    lines.push('', 'Question:', ...agentReply.questions.map((item) => `- ${item}`));
  }
  if (uniqueObservations.length) {
    lines.push('', ...uniqueObservations.map((item) => item.message));
  }
  return lines.join('\n').trim();
}

async function bridgePost(path, body, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetch(`${BRIDGE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-arafatai-token': BRIDGE_TOKEN,
      },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Bridge request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.text || 'Bridge request failed.');
  }
  return data;
}

async function bridgeGet(path) {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    headers: {
      'x-arafatai-token': BRIDGE_TOKEN,
    },
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.text || 'Bridge request failed.');
  }
  return data;
}

async function bridgeReasonFast(body) {
  return bridgePost('/reason', body, { timeoutMs: 10000 });
}

function statusForError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (
    message.includes('failed to fetch') ||
    message.includes('invalid_token') ||
    message.includes('bridge request failed') ||
    message.includes('connection') ||
    message.includes('network')
  ) {
    return 'Needs bridge';
  }
  return 'Stopped';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameUrlWithoutHash(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = '';
    right.hash = '';
    return left.toString() === right.toString();
  } catch {
    return String(a || '') === String(b || '');
  }
}

async function waitForTabNavigation(tabId, { expectedUrl = '', previousUrl = '', timeoutMs = NAVIGATION_SETTLE_TIMEOUT_MS } = {}) {
  if (!tabId) {
    await sleep(POST_ACTION_SETTLE_MS);
    return null;
  }

  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeoutMs) {
    try {
      latest = await chrome.tabs.get(tabId);
    } catch {
      break;
    }

    const currentUrl = latest?.url || '';
    const reachedExpected = expectedUrl && sameUrlWithoutHash(currentUrl, expectedUrl);
    const changedUrl = previousUrl && currentUrl && !sameUrlWithoutHash(currentUrl, previousUrl);
    const complete = latest?.status === 'complete';

    if ((reachedExpected || changedUrl) && complete) return latest;
    await sleep(250);
  }

  await sleep(POST_ACTION_SETTLE_MS);
  return latest;
}

async function startTask(goal, attachments = []) {
  const data = await bridgePost('/tasks', {
    goal,
    history,
    conversation_memory: conversationMemoryPayload(),
    attachments: attachmentPayload(attachments),
  });
  return data.task;
}

function latestPlanEvent(task, step) {
  const events = Array.isArray(task?.events) ? task.events : [];
  const matches = events.filter((event) => event?.kind === 'plan' && Number(event.step) === Number(step));
  return matches[matches.length - 1] || null;
}

async function planTask(taskId, goal, page, taskState, attachments = [], maxPolls = MAX_PLAN_POLLS) {
  updateTaskOverview({
    next: overviewCell(`Planning step ${taskState.step}/${MAX_AGENT_STEPS}`, ''),
  });
  const planningTrace = addTrace(`Planner requested for step ${taskState.step}/${MAX_AGENT_STEPS}.`, '', 'thinking');
  await bridgePost(`/tasks/${taskId}/plan-async`, {
    page,
    attachments: attachmentPayload(attachments),
    task_state: taskState,
    approval_policy: 'auto-safe-actions',
  });

  let lastProgressSecond = 0;
  let waitingTrace = null;
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    setStatus(`Planning ${taskState.step}/${MAX_AGENT_STEPS}...`, true);
    await sleep(PLAN_POLL_INTERVAL_MS);
    const elapsedSeconds = Math.round((poll * PLAN_POLL_INTERVAL_MS) / 1000);
    if (elapsedSeconds >= lastProgressSecond + 15) {
      lastProgressSecond = elapsedSeconds;
      if (!waitingTrace) {
        waitingTrace = addTrace(`Still waiting for planner response (${elapsedSeconds}s).`);
      } else {
        setTraceText(waitingTrace, `Still waiting for planner response (${elapsedSeconds}s).`);
      }
    }
    const data = await bridgeGet(`/tasks/${taskId}`);
    renderTaskTelemetry(data.task);
    const plan = latestPlanEvent(data.task, taskState.step);
    if (!plan) continue;
    if (waitingTrace) setTraceState(waitingTrace, plan.ok ? 'done' : 'error');
    if (!plan.ok) {
      setTraceState(planningTrace, 'error');
      throw new Error(plan.error || plan.text || 'Planning failed.');
    }
    setTraceState(planningTrace, 'done');
    const agentReply = parseAgentReply(plan.text || '');
    updateTaskOverviewFromAgentReply(agentReply);
    renderReasoning(agentReply, plan.source || '');
    return { agentReply, plan };
  }

  const timeoutMessage = `Planner stayed busy after ${Math.round((maxPolls * PLAN_POLL_INTERVAL_MS) / 1000)}s. I stopped this attempt instead of waiting on the same route. Task checkpoint is saved.`;

  try {
    const fallback = await bridgeReasonFast({
      mode: 'agent_task',
      goal,
      page,
      attachments: attachmentPayload(attachments),
      conversation_memory: conversationMemoryPayload(),
      task_state: taskState,
      approval_policy: 'auto-safe-actions',
      force_local: true,
    });
    const agentReply = parseAgentReply(fallback.text || '');
    if (waitingTrace) setTraceState(waitingTrace, 'done');
    setTraceState(planningTrace, 'done');
    updateTaskOverviewFromAgentReply(agentReply);
    addTrace('Async planner timed out, fast local fallback returned a plan.');
    renderReasoning(agentReply, fallback.source || '');
    return { agentReply, plan: fallback };
  } catch {
    if (waitingTrace) setTraceState(waitingTrace, 'error');
    setTraceState(planningTrace, 'error');
    throw new Error(timeoutMessage);
  }
}

async function recordTaskEvent(taskId, event) {
  await bridgePost(`/tasks/${taskId}/event`, { event });
}

function safeUrl(rawUrl) {
  try {
    const text = String(rawUrl || '').trim();
    const withProtocol = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
    const url = new URL(withProtocol);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function hasExplicitRiskApproval(goal) {
  const text = normalizeText(goal).toLowerCase();
  const confirms = /\b(yes|yeah|yep|confirm|confirmed|proceed|go ahead|allow|approve|approved|ok|okay|sure|ji|jee|ha|haan|hmm|korbo|koro|kore dao|kore fel|cholbe|local site)\b/.test(text);
  const risk = /\b(reset|delete|remove|destroy|wipe|erase|clear|drop|truncate|publish|deploy)\b/.test(text);
  return confirms && risk;
}

function approvalContextForGoal(goal) {
  return [
    goal,
    conversationMemory.summary || '',
    conversationMemory.last_task?.goal || '',
    conversationMemory.last_task?.reply || '',
  ].filter(Boolean).join('\n');
}

function isFinalRiskyAction(action) {
  const type = String(action?.type || '').toLowerCase();
  if (['navigate', 'search', 'wait', 'observe'].includes(type)) return false;

  const targetText = normalizeText([
    action?.type,
    action?.target,
    action?.value,
    action?.url,
  ].filter(Boolean).join(' ')).toLowerCase();

  if (!targetText) return false;
  if (type === 'click' && /\b(activate|install now|plugin-install|plugins\.php|data-slug=["']?wp-reset|wp-reset.+activate)\b/.test(targetText)) {
    return false;
  }
  if (/\b(payment|pay|checkout|purchase|bank|card|withdraw|transfer)\b/.test(targetText)) return true;
  if (/\b(delete|destroy|wipe|erase|drop|truncate|irreversible)\b/.test(targetText)) return true;
  if (/\b(reset site|site reset|wp reset|database reset|reset database|factory reset)\b/.test(targetText)) return true;
  if (type === 'click' && /\b(reset|remove|publish|deploy)\b/.test(targetText)) return true;
  if (type === 'type' && /\b(reset|delete|destroy|wipe|erase)\b/.test(targetText)) return true;

  return false;
}

function shouldAutoAcceptPageDialog(action) {
  return Boolean(
    action?.accept_dialog ||
    action?.auto_accept_dialog ||
    String(action?.dialog || '').toLowerCase() === 'accept'
  );
}

async function installOneShotPageDialogAccept(tabId) {
  if (!tabId) return false;

  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (timeoutMs) => {
      const key = '__FLUID_ONE_SHOT_DIALOG_ACCEPT__';
      if (window[key]?.restore) window[key].restore();

      const original = {
        alert: window.alert,
        confirm: window.confirm,
        prompt: window.prompt,
      };

      let used = false;
      const restore = () => {
        if (window[key]?.original !== original) return;
        window.alert = original.alert;
        window.confirm = original.confirm;
        window.prompt = original.prompt;
        delete window[key];
      };
      const timer = window.setTimeout(restore, timeoutMs);
      const consume = (value) => {
        if (!used) {
          used = true;
          window.clearTimeout(timer);
          window.setTimeout(restore, 0);
        }
        return value;
      };

      window[key] = { original, restore };
      window.alert = function fluidAlert() {
        return consume(undefined);
      };
      window.confirm = function fluidConfirm() {
        return consume(true);
      };
      window.prompt = function fluidPrompt(_message, defaultValue) {
        return consume(defaultValue || 'reset');
      };
    },
    args: [12000],
  });

  return true;
}

async function runTabAction(action, tab) {
  if (!tab?.id) return { ok: false, message: 'No active tab found.', action };

  if (action.type === 'navigate') {
    const url = safeUrl(action.url || action.value || action.target);
    if (!url) return { ok: false, message: 'Blocked unsafe or invalid navigation URL.', action };
    const previousUrl = tab.url || '';
    await chrome.tabs.update(tab.id, { url });
    await waitForTabNavigation(tab.id, { expectedUrl: url, previousUrl });
    return { ok: true, message: formatOpenedMessage(url), action, result: { url } };
  }

  if (action.type === 'search') {
    const query = normalizeText(action.value || action.target || action.query || '');
    if (!query) return { ok: false, message: 'Search action missing query.', action };
    const params = new URLSearchParams({ q: query });
    if (action.mode === 'images') params.set('tbm', 'isch');
    const url = `https://www.google.com/search?${params.toString()}`;
    const previousUrl = tab.url || '';
    await chrome.tabs.update(tab.id, { url });
    await waitForTabNavigation(tab.id, { expectedUrl: url, previousUrl });
    return {
      ok: true,
      message: `Opened: Google ${action.mode === 'images' ? 'image ' : ''}search: ${query}`,
      action,
      result: { url },
    };
  }

  return null;
}

async function runPageAction(action, tab) {
  if (!['click', 'type', 'press'].includes(action.type)) return null;

  try {
    const previousUrl = tab?.url || '';
    if (action.type === 'click' && shouldAutoAcceptPageDialog(action)) {
      await installOneShotPageDialogAccept(tab.id);
    }
    const response = await sendTabMessageWithInjection(tab, {
      type: 'ARAFATAI_RUN_ACTION',
      action,
    });
    if (!response && action.type === 'click') {
      await sleep(POST_ACTION_SETTLE_MS);
      return {
        ok: true,
        message: 'Click dispatched; page response was lost, so observing next page.',
        action,
        result: { warning: 'missing_content_script_response_after_click' },
      };
    }
    if (!response?.ok) {
      return { ok: false, message: response?.error || `Page action failed for ${formatAction(action)}.`, action };
    }
    if (action.type === 'click' && response.result?.href) {
      await waitForTabNavigation(tab.id, { expectedUrl: response.result.href, previousUrl });
    } else {
      await sleep(POST_ACTION_SETTLE_MS);
    }
    return { ok: true, message: `${action.type} completed.`, action, result: response.result };
  } catch (error) {
    return { ok: false, message: error.message || String(error), action };
  }
}

async function runManualVerificationAction(action, tab) {
  if (action.type !== 'wait_for_manual_verification') return null;

  const timeoutMs = Math.min(
    Math.max(Number(action.value || action.ms || MANUAL_VERIFICATION_TIMEOUT_MS), 15000),
    MANUAL_VERIFICATION_TIMEOUT_MS,
  );
  const started = Date.now();
  const instruction = addTrace(
    'Manual verification needed.',
    'Please complete the CAPTCHA/checkbox in the page. I will continue automatically after the verification page changes.',
    'thinking',
  );

  while (Date.now() - started < timeoutMs) {
    setStatus('Waiting for manual verification...', true);
    const page = await optionalPageSnapshot(tab);
    if (!isManualVerificationPage(page)) {
      setTraceState(instruction, 'done');
      return {
        ok: true,
        message: `Manual verification completed. Current page: ${page.title || page.url || 'current tab'}.`,
        action,
        snapshot: page,
      };
    }
    await sleep(1500);
  }

  setTraceState(instruction, 'error');
  return {
    ok: false,
    message: 'Manual verification was not completed before the wait timeout.',
    action,
  };
}

async function runAgentAction(action, goal = '', preferredTab = null) {
  if (isFinalRiskyAction(action) && !hasExplicitRiskApproval(goal)) {
    return {
      ok: false,
      message: `Stopped before final destructive action. Confirm once if you want: ${action.reason || action.type}`,
      action,
    };
  }

  if (isBridgeToolAction(action)) {
    return runBridgeToolAction(action);
  }

  const tab = await focusTaskTab(preferredTab);
  const tabResult = await runTabAction(action, tab);
  if (tabResult) return tabResult;

  const pageResult = await runPageAction(action, tab);
  if (pageResult) return pageResult;

  const manualResult = await runManualVerificationAction(action, tab);
  if (manualResult) return manualResult;

  if (action.type === 'wait') {
    const ms = Math.min(Math.max(Number(action.value || action.ms || 1000), 0), 10000);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ok: true, message: `Waited ${ms}ms.`, action };
  }

  if (action.type === 'observe') {
    return { ok: true, message: 'Observed current page.', action, snapshot: await optionalPageSnapshot(tab) };
  }

  return { ok: false, message: `Unsupported action type: ${action.type}`, action };
}

async function runAgentTask(goal, attachments = []) {
  activeTaskId = null;
  startTraceGroup();
  updateTaskOverview({
    goal: goal || 'Uploaded image task',
    next: overviewCell('Creating task checkpoint', ''),
  });
  const task = await startTask(goal, attachments);
  activeTaskId = task.id;
  const initialTab = await activeTab();
  const observations = [];
  let finalReply = '';
  const screenshotPolicy = screenshotPolicyForGoal(goal);
  const planPollLimit = plannerPollLimitForGoal(goal);
  const approvalContext = approvalContextForGoal(goal);

  addTrace(`Task checkpoint created: ${activeTaskId.slice(0, 8)}.`);
  renderTaskTelemetry(task);

  for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
    setStatus(`Working ${step}/${MAX_AGENT_STEPS}...`, true);
    addTrace(`Reading current tab snapshot for step ${step}.`);
    const page = await optionalPageSnapshot(initialTab);
    const screenshot = screenshotPolicy.capture ? await captureCurrentScreenshot(step, initialTab) : null;
    addTrace(`Observed page: ${page.title || page.url || 'current tab'}.`, page.url || '');
    rememberObservedPage(page);
    if (screenshot && screenshotPolicy.show) addSnapshotCard(page, screenshot, step);
    await recordTaskEvent(activeTaskId, {
      kind: 'observation',
      status: 'running',
      step,
      snapshot: page,
      message: `Observed ${page.title || page.url || 'current tab'}.`,
      attachments: [
        ...attachments.map(compactAttachmentForHistory),
        ...(screenshot ? [compactAttachmentForHistory(screenshot, 0)] : []),
      ],
    });

    const { agentReply } = await planTask(activeTaskId, goal, page, {
      step,
      max_steps: MAX_AGENT_STEPS,
      observations: observations.slice(-8),
    }, screenshot ? [screenshot] : [], planPollLimit);

    finalReply = readableReply(agentReply);

    if (agentReply.questions.length || agentReply.done || !agentReply.actions.length) {
      await recordTaskEvent(activeTaskId, {
        kind: 'observation',
        status: agentReply.questions.length ? 'waiting_for_user' : agentReply.done ? 'done' : 'stopped',
        step,
        message: agentReply.questions.length
          ? 'Task is waiting for user input.'
          : agentReply.done
            ? 'Task completed.'
            : 'Task stopped because no next action was returned.',
        reply: agentReply.reply,
        questions: agentReply.questions,
      });
      return readableReply(agentReply, observations.slice(-3));
    }

    const actions = agentReply.actions.slice(0, 3).map(normalizeAgentAction);
    for (const action of actions) {
      const detail = action.normalized_from
        ? `${action.reason || ''}\nNormalized target from "${action.normalized_from}" to "${action.target}".`.trim()
        : action.reason || '';
      const actionTrace = addTrace(`Running ${formatAction(action)}.`, detail, 'thinking');
      const result = await runAgentAction(action, approvalContext, initialTab);
      setTraceState(actionTrace, result.ok ? 'done' : 'error');
      observations.push(result);
      updateTaskOverviewFromActionResult(result);
      addTrace(result.ok ? 'Action completed.' : 'Action blocked/failed.', result.message, result.ok ? 'done' : 'error');
      await recordTaskEvent(activeTaskId, {
        kind: 'observation',
        status: result.ok ? 'running' : 'blocked',
        step,
        action,
        result,
        message: result.message,
      });
      if (!result.ok) {
        await recordTaskEvent(activeTaskId, {
          kind: 'observation',
          status: 'blocked',
          step,
          message: 'Task stopped after a failed action instead of retrying the same route.',
          reply: agentReply.reply,
        });
        return readableReply(agentReply, observations.slice(-3));
      }
    }
  }

  await recordTaskEvent(activeTaskId, {
    kind: 'observation',
    status: 'step_limit',
    step: MAX_AGENT_STEPS,
    message: `Stopped after ${MAX_AGENT_STEPS} steps.`,
  });
  updateTaskOverview({
    next: overviewCell(`Stopped after ${MAX_AGENT_STEPS} steps`, 'warn'),
  });

  return [
    finalReply || 'I started the task but did not finish within the step limit.',
    '',
    `Stopped after ${MAX_AGENT_STEPS} steps. Tell me to continue if needed.`,
    ...Array.from(new Set(observations.slice(-3).map((item) => item.message))),
  ].filter(Boolean).join('\n');
}

async function sendMessage() {
  const rawGoal = normalizeText(els.message.value);
  const attachments = pendingAttachments.slice();
  const goal = rawGoal || (attachments.length ? 'Please inspect the uploaded image(s) and follow my visual instructions in order.' : '');
  if (!goal && !attachments.length) return;

  addMessage('user', rawGoal || 'Uploaded image', attachments);
  els.message.value = '';
  pendingAttachments = [];
  renderPendingAttachments();
  els.send.disabled = true;
  setStatus('Working...', true);

  try {
    const reply = await runAgentTask(goal, attachments);
    clearThinkingTraces();
    addMessage('assistant', reply || '(empty response)');
    rememberTaskResult(goal, reply || '(empty response)', 'done');
    setStatus('Ready');
  } catch (error) {
    clearThinkingTraces('error');
    const message = error.message || String(error);
    updateTaskOverview({
      next: overviewCell('Stopped', 'error'),
      verification: overviewCell(message, 'error'),
    });
    addMessage('assistant', message);
    rememberTaskResult(goal, message, 'error');
    setStatus(statusForError(error));
  } finally {
    clearThinkingTraces();
    els.send.disabled = false;
    scrollThreadToBottom();
    focusMessageInput();
  }
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      resolve(String(reader.result || ''));
    });
    reader.addEventListener('error', () => {
      reject(reader.error || new Error('Could not read image.'));
    });
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(files) {
  const available = Math.max(0, MAX_ATTACHMENTS - pendingAttachments.length);
  const selected = Array.from(files || []).slice(0, available);
  for (const file of selected) {
    if (!file.type.startsWith('image/')) {
      addTrace('Image skipped.', `${file.name} is not an image.`, 'error');
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      addTrace('Image skipped.', `${file.name} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`, 'error');
      continue;
    }
    const dataUrl = await readImageFile(file);
    pendingAttachments.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: file.name,
      type: file.type,
      size: file.size,
      data_url: dataUrl,
      preview_url: dataUrl,
    });
  }
  renderPendingAttachments();
}

els.attach.addEventListener('click', () => {
  els.imageInput.click();
});

els.imageInput.addEventListener('change', async () => {
  try {
    await addImageFiles(els.imageInput.files);
  } catch (error) {
    addTrace('Image upload failed.', error.message || String(error), 'error');
  } finally {
    els.imageInput.value = '';
  }
});

els.send.addEventListener('click', sendMessage);
els.message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
focusMessageInput();
