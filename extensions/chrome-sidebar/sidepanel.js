const els = {
  status: document.getElementById('status'),
  thread: document.getElementById('thread'),
  message: document.getElementById('message'),
  send: document.getElementById('send'),
};

const BRIDGE_URL = 'http://127.0.0.1:8792';
const BRIDGE_TOKEN = 'arafatai-local-token';

let history = [];

function setStatus(text) {
  els.status.textContent = text;
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function addMessage(role, text) {
  const article = document.createElement('article');
  article.className = `message ${role}`;

  const name = document.createElement('span');
  name.textContent = role === 'user' ? 'You' : 'ArafatAI';

  const body = document.createElement('p');
  body.textContent = text || '(empty)';

  article.append(name, body);
  els.thread.append(article);
  article.scrollIntoView({ block: 'end' });

  history.push({ role, text: text || '' });
  history = history.slice(-8);
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
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

async function optionalPageSnapshot() {
  const tab = await activeTab();
  if (!tab?.id || !isScriptableTab(tab)) return fallbackTabSnapshot(tab);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'ARAFATAI_SNAPSHOT' });
    return response?.ok ? response.snapshot : fallbackTabSnapshot(tab);
  } catch (error) {
    if (!isMissingContentScriptError(error)) return fallbackTabSnapshot(tab);

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'ARAFATAI_SNAPSHOT' });
      return response?.ok ? response.snapshot : fallbackTabSnapshot(tab);
    } catch {
      return fallbackTabSnapshot(tab);
    }
  }
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  if (candidate.startsWith('{')) return candidate;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return candidate.slice(start, end + 1);
}

function parseAgentReply(text) {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return {
      reply: String(text || ''),
      questions: [],
      actions: [],
    };
  }

  try {
    const data = JSON.parse(jsonText);
    return {
      reply: String(data.reply || data.answer || ''),
      questions: Array.isArray(data.questions) ? data.questions : [],
      actions: Array.isArray(data.actions) ? data.actions : [],
    };
  } catch {
    return {
      reply: String(text || ''),
      questions: [],
      actions: [],
    };
  }
}

function readableReply(agentReply, actionResults = []) {
  const lines = [];
  if (agentReply.reply) lines.push(agentReply.reply);
  if (Array.isArray(agentReply.questions) && agentReply.questions.length) {
    lines.push('', 'Question:', ...agentReply.questions.map((item) => `- ${item}`));
  }
  if (actionResults.length) {
    lines.push('', ...actionResults.map((item) => item.message));
  }
  return lines.join('\n').trim();
}

async function askBridge(goal, page) {
  const response = await fetch(`${BRIDGE_URL}/reason`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-arafatai-token': BRIDGE_TOKEN,
    },
    body: JSON.stringify({
      mode: 'agent_chat',
      goal,
      page,
      history,
      provider: 'codex',
      approval_policy: 'chat-safe-actions',
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.text || 'Bridge request failed.');
  }

  return parseAgentReply(data.text || '');
}

function cleanSearchQuery(goal) {
  const lower = normalizeText(goal).toLowerCase();
  const withoutCommands = lower
    .replace(/\b(ekhane|ekhankar|current|page|url|ache|ase|e|a|dia|diye|google|search|koro|kor|korte|dao|daw|please|image|images|img|photo|chobi|chhobi|jekono|j kono|any)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return withoutCommands || (/\b(image|images|photo|chobi|chhobi)\b/i.test(goal) ? 'images' : 'search');
}

function inferSafeActions(goal, page) {
  const text = normalizeText(goal);
  const lower = text.toLowerCase();
  const wantsSearch = /\b(search|google|khujo|khuj|find)\b/i.test(lower);
  const wantsImages = /\b(image|images|photo|chobi|chhobi)\b/i.test(lower);

  if (wantsSearch || wantsImages) {
    return [{
      type: 'search',
      value: cleanSearchQuery(text),
      mode: wantsImages ? 'images' : 'web',
      reason: page?.url?.startsWith('chrome://')
        ? 'Chrome internal new-tab page cannot be DOM-controlled, so navigation is used.'
        : 'User asked to search from the current tab.',
    }];
  }

  return [];
}

function safeUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

async function runSafeAction(action) {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, message: 'No active tab found.' };

  if (action.type === 'search') {
    const query = normalizeText(action.value || action.target || 'images');
    const params = new URLSearchParams({ q: query || 'images' });
    if (action.mode === 'images') params.set('tbm', 'isch');
    const url = `https://www.google.com/search?${params.toString()}`;
    await chrome.tabs.update(tab.id, { url });
    return { ok: true, message: `Opened Google ${action.mode === 'images' ? 'image ' : ''}search for: ${query}` };
  }

  if (action.type === 'navigate') {
    const url = safeUrl(action.url || action.value || action.target);
    if (!url) return { ok: false, message: 'Blocked unsafe or invalid navigation URL.' };
    await chrome.tabs.update(tab.id, { url });
    return { ok: true, message: `Opened: ${url}` };
  }

  return { ok: false, message: `Action type "${action.type}" is not available in the simple chat UI yet.` };
}

async function runSafeActions(actions) {
  const allowed = (Array.isArray(actions) ? actions : [])
    .filter((action) => action && ['search', 'navigate'].includes(action.type))
    .slice(0, 1);
  const results = [];

  for (const action of allowed) {
    results.push(await runSafeAction(action));
  }

  return results;
}

async function sendMessage() {
  const goal = normalizeText(els.message.value);
  if (!goal) return;

  addMessage('user', goal);
  els.message.value = '';
  els.send.disabled = true;
  setStatus('Thinking...');

  try {
    const page = await optionalPageSnapshot();
    const agentReply = await askBridge(goal, page);
    const actions = agentReply.actions.length ? agentReply.actions : inferSafeActions(goal, page);
    const actionResults = await runSafeActions(actions);
    addMessage('assistant', readableReply(agentReply, actionResults) || '(empty response)');
    setStatus('Ready');
  } catch (error) {
    addMessage('assistant', error.message || String(error));
    setStatus('Needs bridge');
  } finally {
    els.send.disabled = false;
    els.message.focus();
  }
}

els.send.addEventListener('click', sendMessage);
els.message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
els.message.focus();
