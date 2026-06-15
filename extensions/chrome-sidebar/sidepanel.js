const els = {
  status: document.getElementById('status'),
  thread: document.getElementById('thread'),
  message: document.getElementById('message'),
  send: document.getElementById('send'),
};

const BRIDGE_URL = 'http://127.0.0.1:8792';
const BRIDGE_TOKEN = 'arafatai-local-token';
const MAX_AGENT_STEPS = 5;

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
  history = history.slice(-10);
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

async function optionalPageSnapshot() {
  const tab = await activeTab();
  if (!tab?.id || !isScriptableTab(tab)) return fallbackTabSnapshot(tab);

  try {
    const response = await sendTabMessageWithInjection(tab, { type: 'ARAFATAI_SNAPSHOT' });
    return response?.ok ? response.snapshot : fallbackTabSnapshot(tab);
  } catch {
    return fallbackTabSnapshot(tab);
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
      done: false,
    };
  }

  try {
    const data = JSON.parse(jsonText);
    return {
      reply: String(data.reply || data.answer || ''),
      questions: Array.isArray(data.questions) ? data.questions : [],
      actions: Array.isArray(data.actions) ? data.actions : [],
      done: Boolean(data.done),
    };
  } catch {
    return {
      reply: String(text || ''),
      questions: [],
      actions: [],
      done: false,
    };
  }
}

function readableReply(agentReply, observations = []) {
  const lines = [];
  if (agentReply.reply) lines.push(agentReply.reply);
  if (Array.isArray(agentReply.questions) && agentReply.questions.length) {
    lines.push('', 'Question:', ...agentReply.questions.map((item) => `- ${item}`));
  }
  if (observations.length) {
    lines.push('', ...observations.map((item) => item.message));
  }
  return lines.join('\n').trim();
}

async function askBridge(goal, page, taskState) {
  const response = await fetch(`${BRIDGE_URL}/reason`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-arafatai-token': BRIDGE_TOKEN,
    },
    body: JSON.stringify({
      mode: 'agent_task',
      goal,
      page,
      history,
      task_state: taskState,
      provider: 'codex',
      approval_policy: 'auto-safe-actions',
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.text || 'Bridge request failed.');
  }

  return parseAgentReply(data.text || '');
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

function isRiskyAction(action) {
  const text = [
    action.type,
    action.target,
    action.value,
    action.url,
    action.reason,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(delete|remove|publish|payment|pay|checkout|purchase|merge|deploy|reset|irreversible|destroy)\b/.test(text);
}

async function runTabAction(action, tab) {
  if (!tab?.id) return { ok: false, message: 'No active tab found.', action };

  if (action.type === 'navigate') {
    const url = safeUrl(action.url || action.value || action.target);
    if (!url) return { ok: false, message: 'Blocked unsafe or invalid navigation URL.', action };
    await chrome.tabs.update(tab.id, { url });
    return { ok: true, message: `Opened: ${url}`, action };
  }

  if (action.type === 'search') {
    const query = normalizeText(action.value || action.target || action.query || '');
    if (!query) return { ok: false, message: 'Search action missing query.', action };
    const params = new URLSearchParams({ q: query });
    if (action.mode === 'images') params.set('tbm', 'isch');
    const url = `https://www.google.com/search?${params.toString()}`;
    await chrome.tabs.update(tab.id, { url });
    return {
      ok: true,
      message: `Opened Google ${action.mode === 'images' ? 'image ' : ''}search for: ${query}`,
      action,
    };
  }

  return null;
}

async function runPageAction(action, tab) {
  if (!['click', 'type'].includes(action.type)) return null;

  try {
    const response = await sendTabMessageWithInjection(tab, {
      type: 'ARAFATAI_RUN_ACTION',
      action,
    });
    if (!response?.ok) {
      return { ok: false, message: response?.error || 'Page action failed.', action };
    }
    return { ok: true, message: `${action.type} completed.`, action, result: response.result };
  } catch (error) {
    return { ok: false, message: error.message || String(error), action };
  }
}

async function runAgentAction(action) {
  if (isRiskyAction(action)) {
    return {
      ok: false,
      message: `Stopped before risky action. Please confirm manually if you want: ${action.reason || action.type}`,
      action,
    };
  }

  const tab = await activeTab();
  const tabResult = await runTabAction(action, tab);
  if (tabResult) return tabResult;

  const pageResult = await runPageAction(action, tab);
  if (pageResult) return pageResult;

  if (action.type === 'wait') {
    const ms = Math.min(Math.max(Number(action.value || action.ms || 1000), 0), 10000);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ok: true, message: `Waited ${ms}ms.`, action };
  }

  if (action.type === 'observe') {
    return { ok: true, message: 'Observed current page.', action, snapshot: await optionalPageSnapshot() };
  }

  return { ok: false, message: `Unsupported action type: ${action.type}`, action };
}

async function runAgentTask(goal) {
  const observations = [];
  let finalReply = '';

  for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
    setStatus(`Working ${step}/${MAX_AGENT_STEPS}...`);
    const page = await optionalPageSnapshot();
    const agentReply = await askBridge(goal, page, {
      step,
      max_steps: MAX_AGENT_STEPS,
      observations: observations.slice(-8),
    });

    finalReply = readableReply(agentReply);

    if (agentReply.questions.length || agentReply.done || !agentReply.actions.length) {
      return readableReply(agentReply, observations.slice(-3));
    }

    const actions = agentReply.actions.slice(0, 3);
    for (const action of actions) {
      const result = await runAgentAction(action);
      observations.push(result);
      if (!result.ok) break;
    }
  }

  return [
    finalReply || 'I started the task but did not finish within the step limit.',
    '',
    `Stopped after ${MAX_AGENT_STEPS} steps. Tell me to continue if needed.`,
    ...observations.slice(-3).map((item) => item.message),
  ].filter(Boolean).join('\n');
}

async function sendMessage() {
  const goal = normalizeText(els.message.value);
  if (!goal) return;

  addMessage('user', goal);
  els.message.value = '';
  els.send.disabled = true;
  setStatus('Working...');

  try {
    const reply = await runAgentTask(goal);
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
