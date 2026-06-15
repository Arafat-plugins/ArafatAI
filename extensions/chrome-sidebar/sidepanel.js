const els = {
  goal: document.getElementById('goal'),
  inspect: document.getElementById('inspect'),
  ask: document.getElementById('ask'),
  plan: document.getElementById('plan'),
  run: document.getElementById('run'),
  bridgeUrl: document.getElementById('bridge-url'),
  bridgeToken: document.getElementById('bridge-token'),
  snapshot: document.getElementById('snapshot'),
  response: document.getElementById('response'),
};

let currentSnapshot = null;
let currentAction = null;

function saveSettings() {
  localStorage.setItem('arafatai.bridgeUrl', els.bridgeUrl.value.trim());
  localStorage.setItem('arafatai.bridgeToken', els.bridgeToken.value);
}

function loadSettings() {
  els.bridgeUrl.value = localStorage.getItem('arafatai.bridgeUrl') || els.bridgeUrl.value;
  els.bridgeToken.value = localStorage.getItem('arafatai.bridgeToken') || els.bridgeToken.value;
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

async function requestSnapshot(tab) {
  return chrome.tabs.sendMessage(tab.id, { type: 'ARAFATAI_SNAPSHOT' });
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
  const tab = await activeTab();
  const response = await sendTabMessageWithInjection(tab, { type: 'ARAFATAI_SNAPSHOT' });

  if (!response?.ok) throw new Error('Could not read page snapshot.');
  currentSnapshot = response.snapshot;
  els.snapshot.textContent = JSON.stringify(currentSnapshot, null, 2);
  return currentSnapshot;
}

async function callBridge(mode) {
  saveSettings();
  const page = currentSnapshot || await inspectPage();
  const goal = els.goal.value.trim() || 'Summarize this page and suggest the next safe step.';
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
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.text || 'Bridge request failed.');
  }

  return data.text || '';
}

async function askCodex() {
  els.response.textContent = await callBridge('chat') || '(empty response)';
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function parseBridgePlan(text) {
  const trimmed = String(text || '').trim();
  const jsonText = trimmed.startsWith('{') ? trimmed : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  if (!jsonText) return null;

  try {
    const plan = JSON.parse(jsonText);
    if (!Array.isArray(plan.actions) || !plan.actions[0]) return null;
    return plan.actions[0];
  } catch {
    return null;
  }
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

function setCurrentAction(action) {
  currentAction = action;
  els.run.disabled = !currentAction;
}

async function planAction() {
  const page = currentSnapshot || await inspectPage();
  const goal = els.goal.value.trim();
  let bridgeText = '';
  let action = null;

  try {
    bridgeText = await callBridge('browser_plan');
    action = parseBridgePlan(bridgeText);
  } catch (error) {
    bridgeText = `Codex plan failed: ${error.message || String(error)}`;
  }

  if (!action) {
    action = inferActionFromGoal(goal, page);
  }

  setCurrentAction(action);
  els.response.textContent = action
    ? `Planned action:\n${JSON.stringify(action, null, 2)}\n\nCodex:\n${bridgeText || '(local fallback used)'}`
    : `${bridgeText}\n\nNo safe action found from the current page snapshot.`;
}

async function runAction() {
  const page = currentSnapshot || await inspectPage();
  if (!currentAction) {
    setCurrentAction(inferActionFromGoal(els.goal.value.trim(), page));
  }
  if (!currentAction) throw new Error('No approved action is planned.');

  const tab = await activeTab();
  const response = await sendTabMessageWithInjection(tab, {
    type: 'ARAFATAI_RUN_ACTION',
    action: currentAction,
  });

  if (!response?.ok) throw new Error(response?.error || 'Action failed.');
  currentSnapshot = null;
  els.response.textContent = `Action ran:\n${JSON.stringify(response.result, null, 2)}`;
}

async function withBusy(button, task) {
  button.disabled = true;
  try {
    await task();
  } catch (error) {
    els.response.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
}

loadSettings();
els.bridgeUrl.addEventListener('change', saveSettings);
els.bridgeToken.addEventListener('change', saveSettings);
els.inspect.addEventListener('click', () => withBusy(els.inspect, inspectPage));
els.ask.addEventListener('click', () => withBusy(els.ask, askCodex));
els.plan.addEventListener('click', () => withBusy(els.plan, planAction));
els.run.addEventListener('click', () => withBusy(els.run, runAction));
