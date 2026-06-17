import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function utcNow() {
  return new Date().toISOString();
}

function safeTaskId(taskId) {
  return String(taskId || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

export class TaskStore {
  constructor(root) {
    this.root = root;
    this.ready = mkdir(root, { recursive: true });
  }

  async create(goal, history = [], conversationMemory = {}) {
    await this.ready;
    const now = utcNow();
    const task = {
      id: randomUUID().replace(/-/g, ''),
      goal,
      status: 'running',
      created_at: now,
      updated_at: now,
      history: Array.isArray(history) ? history : [],
      conversation_memory: isPlainObject(conversationMemory) ? conversationMemory : {},
      events: [],
    };
    await this.write(task);
    return task;
  }

  async update(taskId, patch = {}) {
    const task = await this.get(taskId);
    if (!task) return null;
    const next = {
      ...task,
      ...(patch && typeof patch === 'object' ? patch : {}),
      updated_at: utcNow(),
    };
    await this.write(next);
    return next;
  }

  async get(taskId) {
    await this.ready;
    const filePath = this.pathFor(taskId);
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async appendEvent(taskId, event = {}) {
    const task = await this.get(taskId);
    if (!task) return null;

    if (!Array.isArray(task.events)) task.events = [];
    const now = utcNow();
    task.events.push({
      event_id: task.events.length + 1,
      at: now,
      ...(event && typeof event === 'object' ? event : {}),
    });
    task.updated_at = now;
    if (typeof event.status === 'string' && event.status) task.status = event.status;
    await this.write(task);
    return task;
  }

  async observations(taskId, limit = 8) {
    const task = await this.get(taskId);
    if (!task || !Array.isArray(task.events)) return [];
    return task.events
      .filter((event) => event && typeof event === 'object' && event.kind === 'observation')
      .slice(-limit);
  }

  pathFor(taskId) {
    return path.join(this.root, `${safeTaskId(taskId)}.json`);
  }

  async write(task) {
    await this.ready;
    const filePath = this.pathFor(task.id);
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(task, null, 2), 'utf8');
    await rename(tmpPath, filePath);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
