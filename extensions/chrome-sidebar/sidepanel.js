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

async function optionalPageSnapshot() {
  const tab = await activeTab();
  if (!tab?.id || !isScriptableTab(tab)) return {};

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'ARAFATAI_SNAPSHOT' });
    return response?.ok ? response.snapshot : {};
  } catch (error) {
    if (!isMissingContentScriptError(error)) return {};

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'ARAFATAI_SNAPSHOT' });
      return response?.ok ? response.snapshot : {};
    } catch {
      return {};
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

function readableReply(text) {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return String(text || '');

  try {
    const data = JSON.parse(jsonText);
    const lines = [];
    if (data.reply || data.answer) lines.push(String(data.reply || data.answer));
    if (Array.isArray(data.questions) && data.questions.length) {
      lines.push('', 'Question:', ...data.questions.map((item) => `- ${item}`));
    }
    return lines.join('\n').trim() || String(text || '');
  } catch {
    return String(text || '');
  }
}

async function askBridge(goal) {
  const page = await optionalPageSnapshot();
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
      approval_policy: 'chat-only',
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.text || 'Bridge request failed.');
  }

  return readableReply(data.text || '');
}

async function sendMessage() {
  const goal = normalizeText(els.message.value);
  if (!goal) return;

  addMessage('user', goal);
  els.message.value = '';
  els.send.disabled = true;
  setStatus('Thinking...');

  try {
    const reply = await askBridge(goal);
    addMessage('assistant', reply || '(empty response)');
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
