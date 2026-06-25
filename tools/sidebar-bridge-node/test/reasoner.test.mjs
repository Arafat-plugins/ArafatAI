import assert from 'node:assert/strict';
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
