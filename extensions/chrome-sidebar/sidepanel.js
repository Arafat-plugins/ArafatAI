const els = {
  status: document.getElementById('status'),
  thread: document.getElementById('thread'),
  message: document.getElementById('message'),
  send: document.getElementById('send'),
};

const BRIDGE_URL = 'http://127.0.0.1:8792';
const BRIDGE_TOKEN = 'arafatai-local-token';
const MAX_AGENT_STEPS = 5;
const PLAN_POLL_INTERVAL_MS = 1500;
const MAX_PLAN_POLLS = 240;
const POST_ACTION_SETTLE_MS = 900;

let history = [];
let activeTaskId = null;

function setStatus(text, thinking = false) {
  els.status.textContent = text;
  els.status.classList?.toggle('thinking', thinking);
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

function addTrace(text, detail = '', state = '') {
  const article = document.createElement('article');
  article.className = state ? `trace ${state}` : 'trace';

  const label = document.createElement('span');
  label.textContent = 'Working';

  const body = document.createElement('p');
  body.textContent = detail ? `${text}\n${detail}` : text;

  article.append(label, body);
  els.thread.append(article);
  article.scrollIntoView({ block: 'end' });
  return article;
}

function formatAction(action) {
  const type = String(action?.type || 'action');
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
      reasoning_summary: [],
      questions: [],
      actions: [],
      done: false,
      needs_approval: false,
    };
  }

  try {
    const data = JSON.parse(jsonText);
    return {
      reply: String(data.reply || data.answer || ''),
      reasoning_summary: Array.isArray(data.reasoning_summary) ? data.reasoning_summary : [],
      questions: Array.isArray(data.questions) ? data.questions : [],
      actions: Array.isArray(data.actions) ? data.actions : [],
      done: Boolean(data.done),
      needs_approval: Boolean(data.needs_approval),
    };
  } catch {
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

async function bridgePost(path, body) {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-arafatai-token': BRIDGE_TOKEN,
    },
    body: JSON.stringify(body),
  });

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startTask(goal) {
  const data = await bridgePost('/tasks', { goal, history });
  return data.task;
}

function latestPlanEvent(task, step) {
  const events = Array.isArray(task?.events) ? task.events : [];
  const matches = events.filter((event) => event?.kind === 'plan' && Number(event.step) === Number(step));
  return matches[matches.length - 1] || null;
}

async function planTask(taskId, page, taskState) {
  const planningTrace = addTrace(`Planner requested for step ${taskState.step}/${MAX_AGENT_STEPS}.`, '', 'thinking');
  await bridgePost(`/tasks/${taskId}/plan-async`, {
    page,
    task_state: taskState,
    approval_policy: 'auto-safe-actions',
  });

  let lastProgressSecond = 0;
  for (let poll = 1; poll <= MAX_PLAN_POLLS; poll += 1) {
    setStatus(`Planning ${taskState.step}/${MAX_AGENT_STEPS}...`, true);
    await sleep(PLAN_POLL_INTERVAL_MS);
    const elapsedSeconds = Math.round((poll * PLAN_POLL_INTERVAL_MS) / 1000);
    if (elapsedSeconds >= lastProgressSecond + 15) {
      lastProgressSecond = elapsedSeconds;
      addTrace(`Still waiting for planner response (${elapsedSeconds}s).`);
    }
    const data = await bridgeGet(`/tasks/${taskId}`);
    const plan = latestPlanEvent(data.task, taskState.step);
    if (!plan) continue;
    if (!plan.ok) throw new Error(plan.error || plan.text || 'Planning failed.');
    planningTrace.classList?.remove('thinking');
    const agentReply = parseAgentReply(plan.text || '');
    renderReasoning(agentReply, plan.source || '');
    return { agentReply, plan };
  }

  throw new Error(`Still planning after ${Math.round((MAX_PLAN_POLLS * PLAN_POLL_INTERVAL_MS) / 1000)}s. Task checkpoint is saved.`);
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
    await sleep(POST_ACTION_SETTLE_MS);
    return { ok: true, message: `Opened: ${url}`, action };
  }

  if (action.type === 'search') {
    const query = normalizeText(action.value || action.target || action.query || '');
    if (!query) return { ok: false, message: 'Search action missing query.', action };
    const params = new URLSearchParams({ q: query });
    if (action.mode === 'images') params.set('tbm', 'isch');
    const url = `https://www.google.com/search?${params.toString()}`;
    await chrome.tabs.update(tab.id, { url });
    await sleep(POST_ACTION_SETTLE_MS);
    return {
      ok: true,
      message: `Opened Google ${action.mode === 'images' ? 'image ' : ''}search for: ${query}`,
      action,
    };
  }

  return null;
}

async function runPageAction(action, tab) {
  if (!['click', 'type', 'press'].includes(action.type)) return null;

  try {
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
    await sleep(POST_ACTION_SETTLE_MS);
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
  const task = await startTask(goal);
  activeTaskId = task.id;
  const observations = [];
  let finalReply = '';

  addTrace(`Task checkpoint created: ${activeTaskId.slice(0, 8)}.`);

  for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
    setStatus(`Working ${step}/${MAX_AGENT_STEPS}...`, true);
    addTrace(`Reading current tab snapshot for step ${step}.`);
    const page = await optionalPageSnapshot();
    addTrace(`Observed page: ${page.title || page.url || 'current tab'}.`, page.url || '');
    await recordTaskEvent(activeTaskId, {
      kind: 'observation',
      status: 'running',
      step,
      snapshot: page,
      message: `Observed ${page.title || page.url || 'current tab'}.`,
    });

    const { agentReply } = await planTask(activeTaskId, page, {
      step,
      max_steps: MAX_AGENT_STEPS,
      observations: observations.slice(-8),
    });

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
      addTrace(`Running ${formatAction(action)}.`, detail, 'thinking');
      const result = await runAgentAction(action);
      observations.push(result);
      addTrace(result.ok ? 'Action completed.' : 'Action blocked/failed.', result.message);
      await recordTaskEvent(activeTaskId, {
        kind: 'observation',
        status: result.ok ? 'running' : 'blocked',
        step,
        action,
        result,
        message: result.message,
      });
      if (!result.ok) break;
    }
  }

  await recordTaskEvent(activeTaskId, {
    kind: 'observation',
    status: 'step_limit',
    step: MAX_AGENT_STEPS,
    message: `Stopped after ${MAX_AGENT_STEPS} steps.`,
  });

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
    setStatus('Working...', true);

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
