const els = {
  goal: document.getElementById('goal'),
  inspect: document.getElementById('inspect'),
  ask: document.getElementById('ask'),
  bridgeUrl: document.getElementById('bridge-url'),
  bridgeToken: document.getElementById('bridge-token'),
  snapshot: document.getElementById('snapshot'),
  response: document.getElementById('response'),
};

let currentSnapshot = null;

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

async function inspectPage() {
  const tab = await activeTab();
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'ARAFATAI_SNAPSHOT' });
  if (!response?.ok) throw new Error('Could not read page snapshot.');
  currentSnapshot = response.snapshot;
  els.snapshot.textContent = JSON.stringify(currentSnapshot, null, 2);
  return currentSnapshot;
}

async function askCodex() {
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
      mode: 'chat',
      goal,
      page,
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.text || 'Bridge request failed.');
  }

  els.response.textContent = data.text || '(empty response)';
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
