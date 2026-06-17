import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { saveTaskAttachments } from '../src/attachment-store.mjs';
import { buildExtensionPrompt } from '../src/codex-provider.mjs';

const ONE_BY_ONE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

test('saves uploaded images in user order for Codex image input', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aql-attachments-'));
  try {
    const saved = await saveTaskAttachments(root, 'task123', [
      { id: 'first', name: 'first screen.png', type: 'image/png', data_url: ONE_BY_ONE_PNG },
      { id: 'second', name: 'second screen.png', type: 'image/png', data_url: ONE_BY_ONE_PNG },
    ]);

    assert.equal(saved.rejected.length, 0);
    assert.equal(saved.accepted.length, 2);
    assert.equal(saved.accepted[0].order, 1);
    assert.equal(saved.accepted[1].order, 2);
    assert.match(saved.accepted[0].path, /01-first-screen\.png$/);
    assert.match(saved.accepted[1].path, /02-second-screen\.png$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex prompt includes ordered attachment metadata', () => {
  const prompt = buildExtensionPrompt({
    mode: 'agent_task',
    goal: 'follow first image then second image',
    attachments: [
      { order: 1, name: 'first.png', mime_type: 'image/png', size: 10, path: 'C:/tmp/01-first.png' },
      { order: 2, name: 'second.png', mime_type: 'image/png', size: 10, path: 'C:/tmp/02-second.png' },
    ],
  });

  assert.match(prompt, /uploaded images exist/);
  assert.match(prompt, /"order": 1/);
  assert.match(prompt, /"order": 2/);
  assert.match(prompt, /C:\/tmp\/01-first\.png/);
  assert.match(prompt, /C:\/tmp\/02-second\.png/);
});

test('Codex prompt includes durable conversation and task memory', () => {
  const prompt = buildExtensionPrompt({
    mode: 'agent_task',
    goal: 'ebar current tab e add time slot click kore issue bolo',
    conversation_memory: {
      summary: 'User asked where Add time slot is. FLUID answered it is under Monday time dropdowns.',
      last_page: { url: 'https://example.test/add-new', title: 'Add New Listing' },
      last_task: { goal: 'find Add time slot', reply: 'It is in Monday section.', status: 'done' },
    },
    task_memory: {
      goal: 'ebar current tab e add time slot click kore issue bolo',
      recent_plans: [
        {
          step: 1,
          reply: 'I will click Add time slot.',
          actions: [{ type: 'click', target: 'text=+ Add time slot' }],
          done: false,
        },
      ],
      failed_actions: [
        {
          step: 1,
          status: 'blocked',
          message: 'Could not find click target.',
          action: { type: 'click', target: 'ref_999' },
          ok: false,
        },
      ],
    },
  });

  assert.match(prompt, /conversation_memory/);
  assert.match(prompt, /task_memory/);
  assert.match(prompt, /Do not repeat the same failed target\/action/);
  assert.match(prompt, /Add time slot/);
  assert.match(prompt, /Could not find click target/);
});

test('Codex prompt requires valid JSON and one code block for code answers', () => {
  const prompt = buildExtensionPrompt({
    mode: 'agent_task',
    goal: 'exact fixing code dao',
  });

  assert.match(prompt, /The JSON must be valid/);
  assert.match(prompt, /escape every newline inside reply strings/);
  assert.match(prompt, /exactly one fenced code block/);
  assert.match(prompt, /Do not split JS and CSS into separate code blocks/);
});
