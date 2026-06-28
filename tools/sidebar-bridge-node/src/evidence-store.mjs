import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function utcNow() {
  return new Date().toISOString();
}

function safeTaskId(taskId) {
  return String(taskId || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function safeSlug(value, fallback = 'evidence') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

export class EvidenceStore {
  constructor(root, taskStore) {
    this.root = root;
    this.taskStore = taskStore;
    this.ready = mkdir(root, { recursive: true });
  }

  async append(taskId, evidence = {}, payload = undefined) {
    await this.ready;

    if (!this.taskStore || typeof this.taskStore.get !== 'function' || typeof this.taskStore.update !== 'function') {
      throw new Error('EvidenceStore requires a TaskStore-like object.');
    }

    const task = await this.taskStore.get(taskId);
    if (!task) return null;

    const existing = Array.isArray(task.evidence) ? task.evidence : [];
    const evidenceId = existing.length + 1;
    const now = utcNow();
    const type = normalize(evidence.type || 'note');
    const title = normalize(evidence.title || type || 'Evidence');
    const summary = normalize(evidence.summary || '');
    const record = {
      evidence_id: evidenceId,
      type,
      title,
      summary,
      created_at: now,
    };

    if (payload !== undefined) {
      const dir = path.join(this.root, safeTaskId(taskId), 'evidence');
      await mkdir(dir, { recursive: true });
      const filename = `${String(evidenceId).padStart(3, '0')}-${safeSlug(title)}.json`;
      const filePath = path.join(dir, filename);
      await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
      record.path = path.relative(this.root, filePath).replace(/\\/g, '/');
    }

    const updated = await this.taskStore.update(taskId, {
      evidence: [...existing, record],
    });

    return updated ? record : null;
  }

  async list(taskId) {
    const task = await this.taskStore.get(taskId);
    return task && Array.isArray(task.evidence) ? task.evidence : [];
  }
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
