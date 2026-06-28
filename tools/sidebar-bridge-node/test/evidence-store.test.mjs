import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { EvidenceStore } from '../src/evidence-store.mjs';
import { TaskStore } from '../src/task-store.mjs';

test('appends evidence metadata and payload to a task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fluid-evidence-'));

  try {
    const taskStore = new TaskStore(path.join(root, 'tasks'));
    const evidenceStore = new EvidenceStore(path.join(root, 'tasks'), taskStore);
    const task = await taskStore.create('Investigate Directorist search issue');

    const record = await evidenceStore.append(
      task.id,
      {
        type: 'classification',
        title: 'Initial task classification',
        summary: 'investigation/directorist/safe',
      },
      {
        task_type: 'investigation',
        domain: 'directorist',
        risk_level: 'safe',
      },
    );

    assert.equal(record.evidence_id, 1);
    assert.equal(record.type, 'classification');
    assert.match(record.path, new RegExp(`^${task.id}/evidence/001-initial-task-classification\\.json$`));

    const updated = await taskStore.get(task.id);
    assert.equal(updated.evidence.length, 1);
    assert.equal(updated.evidence[0].summary, 'investigation/directorist/safe');

    const payloadPath = path.join(root, 'tasks', record.path);
    const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
    assert.equal(payload.task_type, 'investigation');
    assert.equal(payload.domain, 'directorist');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns null when appending evidence to a missing task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fluid-evidence-missing-'));

  try {
    const taskStore = new TaskStore(path.join(root, 'tasks'));
    const evidenceStore = new EvidenceStore(path.join(root, 'tasks'), taskStore);
    const record = await evidenceStore.append('missing-task', { type: 'note', title: 'Missing' });

    assert.equal(record, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
