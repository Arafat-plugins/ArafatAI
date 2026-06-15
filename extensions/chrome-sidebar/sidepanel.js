const els = {
  provider: document.getElementById('provider'),
  status: document.getElementById('status'),
  thread: document.getElementById('thread'),
  message: document.getElementById('message'),
  inspect: document.getElementById('inspect'),
  send: document.getElementById('send'),
  plan: document.getElementById('plan'),
  run: document.getElementById('run'),
  approvalMode: document.getElementById('approval-mode'),
  bridgeUrl: document.getElementById('bridge-url'),
  bridgeToken: document.getElementById('bridge-token'),
  reasoning: document.getElementById('reasoning'),
  questions: document.getElementById('questions'),
  actions: document.getElementById('actions'),
  snapshot: document.getElementById('snapshot'),
};

let currentSnapshot = null;
let pendingActions = [];
let history = [];

function saveSettings() {
  localStorage.setItem('arafatai.bridgeUrl', els.bridgeUrl.value.trim());
  localStorage.setItem('arafatai.bridgeToken', els.bridgeToken.value);
  localStorage.setItem('arafatai.approvalMode', els.approvalMode.value);
}

function loadSettings() {
  els.bridgeUrl.value = localStorage.getItem('arafatai.bridgeUrl') || els.bridgeUrl.value;
  els.bridgeToken.value = localStorage.getItem('arafatai.bridgeToken') || els.bridgeToken.value;
  els.approvalMode.value = localStorage.getItem('arafatai.approvalMode') || els.approvalMode.value;
}

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

function renderList(el, items, emptyText) {
  el.textContent = '';
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];

  if (!safeItems.length) {
    const li = document.createElement('li');
    li.textContent = emptyText;
    el.append(li);
    return;
  }

  for (const item of safeItems.slice(0, 6)) {
    const li = document.createElement('li');
    li.textContent = typeof item === 'string' ? item : JSON.stringify(item);
    el.append(li);
  }
}

function renderReasoning(items) {
  renderList(els.reasoning, items, 'No reasoning yet.');
}

function renderQuestions(items) {
  renderList(els.questions, items, 'No questions.');
}

function setPendingActions(actions) {
  pendingActions = Array.isArray(actions)
    ? actions.filter((action) => action && typeof action === 'object')
    : [];
  els.actions.textContent = pendingActions.length
    ? JSON.stringify(pendingActions, null, 2)
    : 'No pending action.';
  els.run.disabled = !pendingActions.length || els.approvalMode.value === 'plan-only';
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error('No active tab found.');
  return tabs[0];
}

function isMissingContentScriptError(error) {
  const message = error?.message || String(error || '');
  return message.includes('Receiving end does not exist') || message.includes('Could not establish connection');
}

function isScriptableTab(tab) {
  return /^https?:\/\//.test(tab.url || '') || /^file:\/\//.test(tab.url || '');
}

async function sendTabMessageWithInjection(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!isMissingContentScriptError(error) || !isScriptableTab(tab)) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function inspectPage() {
  setStatus('Inspecting page...');
  const tab = await activeTab();
  const response = await sendTabMessageWithInjection(tab, { type: 'ARAFATAI_SNAPSHOT' });

  if (!response?.ok) throw new Error('Could not read page snapshot.');
  currentSnapshot = response.snapshot;
  els.snapshot.textContent = JSON.stringify(currentSnapshot, null, 2);
  setStatus(`Inspected: ${currentSnapshot.title || currentSnapshot.url}`);
  return currentSnapshot;
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

function normalizeAgentReply(text) {
  const jsonText = extractJsonObject(text);

  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      return {
        reply: String(parsed.reply || parsed.answer || ''),
        reasoning_summary: Array.isArray(parsed.reasoning_summary)
          ? parsed.reasoning_summary
          : Array.isArray(parsed.thinking_summary)
            ? parsed.thinking_summary
            : [],
        questions: Array.isArray(parsed.questions) ? parsed.questions : [],
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        needs_approval: parsed.needs_approval !== false,
        raw: parsed,
      };
    } catch {
      // Fall through to plain text.
    }
  }

  return {
    reply: String(text || ''),
    reasoning_summary: [],
    questions: [],
    actions: [],
    needs_approval: true,
    raw: null,
  };
}

async function callBridge(mode, goal) {
  saveSettings();
  const page = currentSnapshot || await inspectPage();
  const url = els.bridgeUrl.value.replace(/\/+$/, '') + '/reason';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-arafatai-token': els.bridgeToken.value,
    },
    body: JSON.stringify({
      mode,
      goal,
      page,
      history,
      provider: els.provider.value,
      approval_policy: els.approvalMode.value,
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.text || 'Bridge request failed.');
  }

  return normalizeAgentReply(data.text || '');
}

function inferActionFromGoal(goal, snapshot) {
  const stopWords = new Set(['click', 'koro', 'kor', 'kore', 'dao', 'e', 'a', 'the', 'button', 'btn', 'please', 'eta', 'oita']);
  const tokens = normalizeText(goal)
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((token) => token.length >= 3 && !stopWords.has(token));

  for (const token of tokens) {
    const match = (snapshot.clickables || []).find((item) => normalizeText(item.text).toLowerCase().includes(token));
    if (match?.text) {
      return {
        type: 'click',
        target: `text=${normalizeText(match.text)}`,
        reason: `Matched visible text for "${token}".`,
      };
    }
  }

  return null;
}

function renderAgentReply(agentReply) {
  addMessage('assistant', agentReply.reply || 'I inspected the page and prepared the next step.');
  renderReasoning(agentReply.reasoning_summary);
  renderQuestions(agentReply.questions);
  setPendingActions(agentReply.actions);
}

async function askAgent(mode) {
  const goal = normalizeText(els.message.value);
  if (!goal) throw new Error('Write a request first.');

  addMessage('user', goal);
  els.message.value = '';
  setStatus(mode === 'agent_plan' ? 'Planning...' : 'Thinking...');

  let agentReply;
  try {
    agentReply = await callBridge(mode, goal);
  } catch (error) {
    const page = currentSnapshot || await inspectPage();
    const fallbackAction = mode === 'agent_plan' ? inferActionFromGoal(goal, page) : null;
    agentReply = {
      reply: error.message || String(error),
      reasoning_summary: fallbackAction ? ['Codex bridge failed, so the local matcher used visible page text.'] : [],
      questions: fallbackAction ? [] : ['Should I inspect the page again or do you want to start the bridge server?'],
      actions: fallbackAction ? [fallbackAction] : [],
      needs_approval: true,
    };
  }

  if (mode === 'agent_plan' && !agentReply.actions.length) {
    const page = currentSnapshot || await inspectPage();
    const fallbackAction = inferActionFromGoal(goal, page);
    if (fallbackAction) {
      agentReply.actions = [fallbackAction];
      agentReply.reasoning_summary = [
        ...(agentReply.reasoning_summary || []),
        'Local fallback matched the goal to a visible clickable element.',
      ];
    }
  }

  renderAgentReply(agentReply);
  setStatus(agentReply.questions.length ? 'Waiting for answer' : pendingActions.length ? 'Waiting for approval' : 'Ready');
}

async function runPendingActions() {
  if (els.approvalMode.value === 'plan-only') {
    throw new Error('Approval mode is Plan only. Change it to Ask before acting first.');
  }
  if (!pendingActions.length) throw new Error('No pending action is planned.');

  setStatus('Running approved action...');
  const tab = await activeTab();
  const results = [];

  for (const action of pendingActions) {
    if (!['click', 'type'].includes(action.type)) {
      results.push({ ok: false, error: `Unsupported action type: ${action.type}`, action });
      continue;
    }

    const response = await sendTabMessageWithInjection(tab, {
      type: 'ARAFATAI_RUN_ACTION',
      action,
    });

    if (!response?.ok) {
      results.push({ ok: false, error: response?.error || 'Action failed.', action });
      break;
    }

    results.push({ ok: true, result: response.result });
  }

  currentSnapshot = null;
  setPendingActions([]);
  addMessage('assistant', `Action result:\n${JSON.stringify(results, null, 2)}`);
  renderReasoning(['Ran only after your approval click.', 'Cleared the snapshot so the next step re-inspects the updated page.']);
  renderQuestions([]);
  setStatus('Ready');
}

async function withBusy(button, task) {
  const previousDisabled = button.disabled;
  button.disabled = true;
  try {
    await task();
  } catch (error) {
    addMessage('assistant', error.message || String(error));
    setStatus('Needs attention');
  } finally {
    button.disabled = previousDisabled;
    if (button === els.run) {
      els.run.disabled = !pendingActions.length || els.approvalMode.value === 'plan-only';
    }
  }
}

loadSettings();
setPendingActions([]);
els.bridgeUrl.addEventListener('change', saveSettings);
els.bridgeToken.addEventListener('change', saveSettings);
els.approvalMode.addEventListener('change', () => {
  saveSettings();
  setPendingActions(pendingActions);
});
els.inspect.addEventListener('click', () => withBusy(els.inspect, inspectPage));
els.send.addEventListener('click', () => withBusy(els.send, () => askAgent('agent_chat')));
els.plan.addEventListener('click', () => withBusy(els.plan, () => askAgent('agent_plan')));
els.run.addEventListener('click', () => withBusy(els.run, runPendingActions));
els.message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    els.send.click();
  }
});
