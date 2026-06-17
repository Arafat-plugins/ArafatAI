import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createReasoner } from './reasoner.mjs';
import { saveTaskAttachments } from './attachment-store.mjs';
import { TaskStore } from './task-store.mjs';

export const DEFAULT_TOKEN = 'arafatai-local-token';

function parseArgs(argv = process.argv.slice(2)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const config = {
    host: '127.0.0.1',
    port: 8792,
    token: DEFAULT_TOKEN,
    cwd: repoRoot,
    provider: 'codex',
    codexPath: '',
    timeoutSeconds: 120,
    allowLocalFallback: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--host' && next) {
      config.host = next;
      i += 1;
    } else if (arg === '--port' && next) {
      config.port = Number(next);
      i += 1;
    } else if (arg === '--token' && next) {
      config.token = next;
      i += 1;
    } else if (arg === '--cwd' && next) {
      config.cwd = path.resolve(next);
      i += 1;
    } else if (arg === '--provider' && next) {
      config.provider = next;
      i += 1;
    } else if (arg === '--codex-path' && next) {
      config.codexPath = next;
      i += 1;
    } else if (arg === '--timeout' && next) {
      config.timeoutSeconds = Number(next);
      i += 1;
    } else if (arg === '--allow-local-fallback') {
      config.allowLocalFallback = true;
    }
  }

  return config;
}

export function createBridgeServer(config = {}) {
  const finalConfig = {
    host: config.host || '127.0.0.1',
    port: Number(config.port || 8792),
    token: config.token || DEFAULT_TOKEN,
    cwd: path.resolve(config.cwd || process.cwd()),
    provider: config.provider || 'codex',
    codexPath: config.codexPath || '',
    timeoutSeconds: Number(config.timeoutSeconds || 120),
    allowLocalFallback: Boolean(config.allowLocalFallback),
  };
  const tasks = new TaskStore(path.join(finalConfig.cwd, 'runs', 'bridge-tasks'));
  const planningTasks = new Set();
  const reason = createReasoner(finalConfig);
  const attachmentRoot = path.join(finalConfig.cwd, 'runs', 'bridge-attachments');

  async function saveIncomingAttachments(taskId, body, namespace = '') {
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (!attachments.length) return [];
    const taskState = isPlainObject(body.task_state) ? body.task_state : {};
    const step = taskState.step ? `step-${taskState.step}` : namespace || 'request';
    const storageId = namespace ? `${taskId}-${namespace}-${step}` : taskId;
    const saved = await saveTaskAttachments(attachmentRoot, storageId, attachments);
    return saved.accepted;
  }

  async function buildPlanRequest(taskId, body) {
    const task = await tasks.get(taskId);
    if (!task) return null;
    const taskState = isPlainObject(body.task_state) ? body.task_state : {};
    const taskAttachments = Array.isArray(task.attachments) ? task.attachments : [];
    const requestAttachments = await saveIncomingAttachments(taskId, body, 'plan');
    const conversationMemory = isPlainObject(body.conversation_memory)
      ? body.conversation_memory
      : isPlainObject(task.conversation_memory)
        ? task.conversation_memory
        : {};
    return {
      mode: 'agent_task',
      goal: task.goal || '',
      page: isPlainObject(body.page) ? body.page : {},
      history: Array.isArray(task.history) ? task.history : [],
      conversation_memory: conversationMemory,
      task_memory: buildTaskMemory(task),
      attachments: [...taskAttachments, ...requestAttachments],
      task_state: {
        ...taskState,
        task_id: taskId,
        observations: await tasks.observations(taskId),
      },
      approval_policy: body.approval_policy || 'auto-safe-actions',
    };
  }

  async function runPlanJob(taskId, body) {
    let taskState = {};
    try {
      const request = await buildPlanRequest(taskId, body);
      if (!request) return;
      taskState = isPlainObject(request.task_state) ? request.task_state : {};
      const result = await reason(request);
      await tasks.appendEvent(taskId, {
        kind: 'plan',
        status: result.ok ? 'running' : 'blocked',
        step: taskState.step,
        ok: result.ok,
        text: result.text,
        source: result.source,
        error: result.error,
      });
    } catch (error) {
      await tasks.appendEvent(taskId, {
        kind: 'plan',
        status: 'blocked',
        step: taskState.step || body?.task_state?.step || '',
        ok: false,
        text: '',
        source: 'node-bridge',
        error: error?.stack || error?.message || String(error),
      });
    } finally {
      planningTasks.delete(taskId);
    }
  }

  return http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || 'internal_error' });
    }
  });

  async function handleRequest(req, res) {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const routePath = requestUrl.pathname;

    if (req.method === 'OPTIONS') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && (routePath === '/' || routePath === '/health')) {
      sendJson(res, 200, {
        ok: true,
        service: 'FLUID local Node bridge',
        provider: finalConfig.provider,
        routes: [
          '/health',
          '/reason',
          '/tasks',
          '/tasks/{id}',
          '/tasks/{id}/plan',
          '/tasks/{id}/plan-async',
          '/tasks/{id}/event',
        ],
      });
      return;
    }

    const taskId = taskIdFromPath(routePath);

    if (req.method === 'GET' && taskId) {
      if (!authorized(req, finalConfig.token)) {
        sendJson(res, 403, { ok: false, error: 'invalid_token' });
        return;
      }
      const task = await tasks.get(taskId);
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'task_not_found' });
        return;
      }
      sendJson(res, 200, { ok: true, task });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    if (!authorized(req, finalConfig.token)) {
      sendJson(res, 403, { ok: false, error: 'invalid_token' });
      return;
    }

    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }

    if (routePath === '/tasks') {
      const goal = String(body.goal || '').trim();
      if (!goal) {
        sendJson(res, 400, { ok: false, error: 'missing_goal' });
        return;
      }
      let task = await tasks.create(
        goal,
        Array.isArray(body.history) ? body.history : [],
        isPlainObject(body.conversation_memory) ? body.conversation_memory : {},
      );
      const saved = await saveTaskAttachments(
        attachmentRoot,
        task.id,
        Array.isArray(body.attachments) ? body.attachments : [],
      );
      if (saved.accepted.length || saved.rejected.length) {
        task = await tasks.update(task.id, {
          attachments: saved.accepted,
          rejected_attachments: saved.rejected,
        });
      }
      sendJson(res, 200, { ok: true, task });
      return;
    }

    if (taskId && routePath.endsWith('/event')) {
      const event = isPlainObject(body.event) ? body.event : body;
      const task = await tasks.appendEvent(taskId, event);
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'task_not_found' });
        return;
      }
      sendJson(res, 200, { ok: true, task });
      return;
    }

    if (taskId && routePath.endsWith('/plan')) {
      const request = await buildPlanRequest(taskId, body);
      if (!request) {
        sendJson(res, 404, { ok: false, error: 'task_not_found' });
        return;
      }
      const taskState = isPlainObject(request.task_state) ? request.task_state : {};
      const result = await reason(request);
      await tasks.appendEvent(taskId, {
        kind: 'plan',
        status: result.ok ? 'running' : 'blocked',
        step: taskState.step,
        ok: result.ok,
        text: result.text,
        source: result.source,
        error: result.error,
      });
      sendJson(res, result.ok ? 200 : 502, {
        ok: result.ok,
        text: result.text,
        source: result.source,
        error: result.error,
        task_id: taskId,
      });
      return;
    }

    if (taskId && routePath.endsWith('/plan-async')) {
      const task = await tasks.get(taskId);
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'task_not_found' });
        return;
      }

      const alreadyPlanning = planningTasks.has(taskId);
      if (!alreadyPlanning) {
        planningTasks.add(taskId);
        const taskState = isPlainObject(body.task_state) ? body.task_state : {};
        await tasks.appendEvent(taskId, {
          kind: 'planning_started',
          status: 'planning',
          step: taskState.step,
          message: 'AI planning started in the background.',
        });
        setImmediate(() => {
          runPlanJob(taskId, body).catch(() => {
            planningTasks.delete(taskId);
          });
        });
      }

      sendJson(res, 202, {
        ok: true,
        task_id: taskId,
        status: 'planning',
        already_planning: alreadyPlanning,
      });
      return;
    }

    if (routePath === '/reason') {
      const result = await reason(body);
      sendJson(res, result.ok ? 200 : 502, {
        ok: result.ok,
        text: result.text,
        source: result.source,
        error: result.error,
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  }
}

function taskIdFromPath(routePath) {
  const parts = routePath.split('/').filter(Boolean);
  return parts.length >= 2 && parts[0] === 'tasks' ? parts[1] : '';
}

function authorized(req, token) {
  return Boolean(token) && req.headers['x-arafatai-token'] === token;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(raw || '{}');
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-arafatai-token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function shorten(value, limit = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  if (candidate.startsWith('{')) return candidate;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : '';
}

function parsePlanText(text) {
  const json = extractJsonObject(text);
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function compactAction(action = {}) {
  if (!isPlainObject(action)) return {};
  return {
    type: action.type || '',
    target: shorten(action.target || action.url || action.value || '', 220),
    value: shorten(action.value || action.text || '', 220),
    reason: shorten(action.reason || '', 220),
  };
}

function compactHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .filter(isPlainObject)
    .slice(-8)
    .map((entry) => ({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      text: shorten(entry.text, 500),
    }));
}

function compactObservation(event = {}) {
  const result = isPlainObject(event.result) ? event.result : {};
  return {
    step: event.step || '',
    status: event.status || '',
    message: shorten(event.message || result.message || '', 350),
    action: compactAction(event.action || result.action),
    ok: typeof result.ok === 'boolean' ? result.ok : event.status !== 'blocked',
  };
}

function compactPlan(event = {}) {
  const parsed = parsePlanText(event.text);
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  return {
    step: event.step || '',
    source: event.source || '',
    ok: Boolean(event.ok),
    reply: shorten(parsed.reply || '', 500),
    actions: actions.slice(0, 3).map(compactAction),
    done: Boolean(parsed.done),
    questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3).map((item) => shorten(item, 220)) : [],
  };
}

function lastPageFromEvents(events = []) {
  for (const event of [...events].reverse()) {
    if (event?.kind !== 'observation' || !isPlainObject(event.snapshot)) continue;
    return {
      url: event.snapshot.url || '',
      title: event.snapshot.title || '',
      visible_text_sample: shorten(event.snapshot.visible_text, 500),
      captured_at: event.snapshot.captured_at || event.at || '',
    };
  }
  return null;
}

function buildTaskMemory(task = {}) {
  const events = Array.isArray(task.events) ? task.events : [];
  const observations = events.filter((event) => event?.kind === 'observation').map(compactObservation);
  const actionEvents = observations.filter((event) => event.action?.type);

  return {
    task_id: task.id || '',
    goal: shorten(task.goal, 700),
    status: task.status || '',
    history: compactHistory(task.history),
    last_page: lastPageFromEvents(events),
    recent_plans: events.filter((event) => event?.kind === 'plan').slice(-5).map(compactPlan),
    recent_observations: observations.slice(-10),
    successful_actions: actionEvents.filter((event) => event.ok).slice(-6),
    failed_actions: actionEvents.filter((event) => !event.ok).slice(-6),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = parseArgs();
  const server = createBridgeServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`FLUID Node bridge listening on http://${config.host}:${config.port}`);
    console.log('Press Ctrl+C to stop.');
  });
}
