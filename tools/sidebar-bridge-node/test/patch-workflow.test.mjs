import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { PatchWorkflowStore } from '../src/patch-workflow.mjs';

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fluid-patch-workflow-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

test('prepares backup and patched copy without changing target', async () => {
  const root = await makeWorkspace();
  try {
    const target = path.join(root, 'src', 'demo.js');
    await writeFile(target, 'const value = 1;\n', 'utf8');
    const store = new PatchWorkflowStore({ workspaceRoot: root });
    const result = await store.prepare({
      target_path: 'src/demo.js',
      patched_content: 'const value = 2;\n',
      label: 'demo update',
    });

    assert.equal(result.target_relative_path, 'src/demo.js');
    assert.equal(result.changed, true);
    assert.equal(await readFile(target, 'utf8'), 'const value = 1;\n');
    assert.equal(await readFile(result.backup_path, 'utf8'), 'const value = 1;\n');
    assert.equal(await readFile(result.patched_path, 'utf8'), 'const value = 2;\n');
    assert.notEqual(result.original_sha256, result.patched_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runs safe syntax check against patched copy', async () => {
  const root = await makeWorkspace();
  try {
    const target = path.join(root, 'src', 'demo.js');
    await writeFile(target, 'const value = 1;\n', 'utf8');
    const store = new PatchWorkflowStore({ workspaceRoot: root });
    const prepared = await store.prepare({
      target_path: target,
      patched_content: 'const value = 2;\n',
      label: 'node check',
    });
    const result = await store.check({
      workflow_id: prepared.workflow_id,
      checker: 'node_check',
    });

    assert.equal(result.ok, true);
    assert.equal(result.exit_code, 0);
    assert.equal(result.checker, 'node_check');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks apply without explicit approval', async () => {
  const root = await makeWorkspace();
  try {
    const target = path.join(root, 'src', 'demo.js');
    await writeFile(target, 'const value = 1;\n', 'utf8');
    const store = new PatchWorkflowStore({ workspaceRoot: root });
    const prepared = await store.prepare({
      target_path: target,
      patched_content: 'const value = 2;\n',
    });

    await assert.rejects(
      () => store.apply({ workflow_id: prepared.workflow_id }),
      /approved: true/,
    );
    assert.equal(await readFile(target, 'utf8'), 'const value = 1;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applies prepared copy only when approved and current hash still matches', async () => {
  const root = await makeWorkspace();
  try {
    const target = path.join(root, 'src', 'demo.js');
    await writeFile(target, 'const value = 1;\n', 'utf8');
    const store = new PatchWorkflowStore({ workspaceRoot: root });
    const prepared = await store.prepare({
      target_path: target,
      patched_content: 'const value = 2;\n',
    });
    const applied = await store.apply({
      workflow_id: prepared.workflow_id,
      approved: true,
    });

    assert.equal(applied.applied, true);
    assert.equal(await readFile(target, 'utf8'), 'const value = 2;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks stale apply when target changed after backup', async () => {
  const root = await makeWorkspace();
  try {
    const target = path.join(root, 'src', 'demo.js');
    await writeFile(target, 'const value = 1;\n', 'utf8');
    const store = new PatchWorkflowStore({ workspaceRoot: root });
    const prepared = await store.prepare({
      target_path: target,
      patched_content: 'const value = 2;\n',
    });
    await writeFile(target, 'const value = 3;\n', 'utf8');

    await assert.rejects(
      () => store.apply({ workflow_id: prepared.workflow_id, approved: true }),
      /changed since backup/,
    );
    assert.equal(await readFile(target, 'utf8'), 'const value = 3;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks target paths outside workspace', async () => {
  const root = await makeWorkspace();
  try {
    const store = new PatchWorkflowStore({ workspaceRoot: root });
    await assert.rejects(
      () => store.prepare({
        target_path: '../outside.js',
        patched_content: 'const value = 1;\n',
      }),
      /outside the allowed workspace root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
