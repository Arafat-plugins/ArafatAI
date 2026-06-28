import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createReasoner } from '../src/reasoner.mjs';
import { DEFAULT_TIMEOUT_SECONDS } from '../src/server.mjs';

test('Node bridge default timeout stays responsive', () => {
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 45);
});

test('force_local bypasses Codex provider for timeout fallback', async () => {
  const reason = createReasoner({ provider: 'codex', codexPath: 'missing-codex.exe' });
  const result = await reason({
    mode: 'agent_task',
    goal: 'set up my whole workflow',
    force_local: true,
    page: { url: 'https://example.test/', title: 'Example' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'node-local-planner-fallback');
  assert.match(result.text, /I need one more detail/);
});

test('python-core provider uses the same sidebar JSON contract', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fluid-python-core-provider-'));
  const script = path.join(cwd, 'fake-python-core.mjs');
  await writeFile(
    script,
    `
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const body = JSON.parse(raw || '{}');
  process.stdout.write(JSON.stringify({
    ok: true,
    text: JSON.stringify({
      reply: 'Python core handled: ' + body.goal,
      reasoning_summary: ['Fake core received the sidebar request.'],
      questions: [],
      actions: [],
      done: true,
      needs_approval: false
    }),
    source: 'python-core-test',
    error: null
  }));
});
`,
    'utf8',
  );

  try {
    const reason = createReasoner({
      provider: 'python-core',
      pythonCommand: process.execPath,
      pythonArgs: [script],
      cwd,
      timeoutSeconds: 2,
    });
    const result = await reason({
      mode: 'agent_task',
      goal: 'check current page',
      page: { url: 'https://example.test/', title: 'Example' },
    });
    const payload = JSON.parse(result.text);

    assert.equal(result.ok, true);
    assert.equal(result.source, 'python-core-test');
    assert.equal(payload.reply, 'Python core handled: check current page');
    assert.deepEqual(payload.actions, []);
    assert.equal(payload.done, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('python-core provider can fall back to node-local planner when configured', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fluid-python-core-fallback-'));
  const script = path.join(cwd, 'bad-python-core.mjs');
  await writeFile(script, 'process.exit(2);\n', 'utf8');

  try {
    const reason = createReasoner({
      provider: 'python-core',
      pythonCommand: process.execPath,
      pythonArgs: [script],
      cwd,
      timeoutSeconds: 2,
      allowLocalFallback: true,
    });
    const result = await reason({
      mode: 'agent_task',
      goal: 'set up my whole workflow',
      page: { url: 'https://example.test/', title: 'Example' },
    });

    assert.equal(result.ok, true);
    assert.match(result.source, /^node-local-planner-fallback-after-python-core-/);
    assert.match(result.text, /I need one more detail/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
