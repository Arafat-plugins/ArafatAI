import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_CHECK_TIMEOUT_MS = 15000;
const CHECKERS = new Set(['node_check', 'php_lint']);

export class PatchWorkflowStore {
  constructor(options = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.patchRoot = path.resolve(options.patchRoot || path.join(this.workspaceRoot, 'runs', 'patch-workflows'));
    this.ready = mkdir(this.patchRoot, { recursive: true });
  }

  async prepare(input = {}) {
    await this.ready;

    const targetPath = this.resolveWorkspacePath(input.target_path || input.targetPath);
    const patchedContent = String(input.patched_content ?? input.patchedContent ?? '');
    if (!targetPath) throw new Error('Patch workflow requires target_path.');
    if (!Object.prototype.hasOwnProperty.call(input, 'patched_content') && !Object.prototype.hasOwnProperty.call(input, 'patchedContent')) {
      throw new Error('Patch workflow requires patched_content.');
    }

    const targetStat = await stat(targetPath);
    if (!targetStat.isFile()) throw new Error('Patch workflow target must be a file.');

    const originalContent = await readFile(targetPath, 'utf8');
    const originalHash = sha256(originalContent);
    const expectedHash = normalize(input.expected_original_sha256 || input.expectedOriginalSha256);
    if (expectedHash && expectedHash !== originalHash) {
      throw new Error('Target file hash does not match expected_original_sha256.');
    }

    const workflowId = workflowIdFor(input.label || targetPath);
    const workflowDir = this.resolvePatchPath(workflowId);
    await mkdir(workflowDir, { recursive: true });

    const basename = safeBasename(targetPath);
    const backupPath = path.join(workflowDir, `backup-${basename}`);
    const patchedPath = path.join(workflowDir, `patched-${basename}`);
    const manifestPath = path.join(workflowDir, 'manifest.json');
    await copyFile(targetPath, backupPath);
    await writeFile(patchedPath, patchedContent, 'utf8');

    const patchedHash = sha256(patchedContent);
    const manifest = {
      workflow_id: workflowId,
      label: normalize(input.label || ''),
      created_at: new Date().toISOString(),
      workspace_root: this.workspaceRoot,
      target_path: targetPath,
      target_relative_path: path.relative(this.workspaceRoot, targetPath).replace(/\\/g, '/'),
      backup_path: backupPath,
      patched_path: patchedPath,
      original_sha256: originalHash,
      patched_sha256: patchedHash,
      changed: originalHash !== patchedHash,
      applied_at: '',
    };

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return publicManifest(manifest, this.patchRoot);
  }

  async check(input = {}) {
    const manifest = await this.readManifest(input.workflow_id || input.workflowId);
    const checker = normalize(input.checker || 'node_check');
    if (!CHECKERS.has(checker)) throw new Error(`Unsupported patch checker: ${checker}.`);

    const command = checker === 'php_lint'
      ? [input.php || 'php', ['-l', manifest.patched_path]]
      : [input.node || process.execPath, ['--check', manifest.patched_path]];
    const result = await runCommand(command[0], command[1], {
      cwd: this.workspaceRoot,
      timeoutMs: safeInteger(input.timeout_ms ?? input.timeoutMs, DEFAULT_CHECK_TIMEOUT_MS, 1000, 60000),
    });

    return {
      workflow_id: manifest.workflow_id,
      checker,
      command: [command[0], ...command[1]],
      ok: result.exit_code === 0,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      timed_out: result.timed_out,
    };
  }

  async apply(input = {}) {
    const manifest = await this.readManifest(input.workflow_id || input.workflowId);
    if (input.approved !== true) {
      throw new Error('Patch apply requires approved: true.');
    }
    if (manifest.applied_at) {
      throw new Error('Patch workflow has already been applied.');
    }

    const currentContent = await readFile(manifest.target_path, 'utf8');
    const currentHash = sha256(currentContent);
    if (currentHash !== manifest.original_sha256) {
      throw new Error('Target file changed since backup; refusing to apply stale patched copy.');
    }

    const patchedContent = await readFile(manifest.patched_path, 'utf8');
    const patchedHash = sha256(patchedContent);
    if (patchedHash !== manifest.patched_sha256) {
      throw new Error('Patched copy hash changed; refusing to apply.');
    }

    const tmpPath = `${manifest.target_path}.fluid-${manifest.workflow_id}.tmp`;
    await writeFile(tmpPath, patchedContent, 'utf8');
    await rename(tmpPath, manifest.target_path);

    const nextManifest = {
      ...manifest,
      applied_at: new Date().toISOString(),
    };
    await writeFile(this.manifestPath(manifest.workflow_id), JSON.stringify(nextManifest, null, 2), 'utf8');

    return {
      workflow_id: manifest.workflow_id,
      target_path: manifest.target_path,
      target_relative_path: manifest.target_relative_path,
      backup_path: manifest.backup_path,
      patched_path: manifest.patched_path,
      original_sha256: manifest.original_sha256,
      patched_sha256: manifest.patched_sha256,
      applied: true,
      applied_at: nextManifest.applied_at,
    };
  }

  async get(workflowId) {
    return publicManifest(await this.readManifest(workflowId), this.patchRoot);
  }

  async readManifest(workflowId) {
    const id = safeWorkflowId(workflowId);
    if (!id) throw new Error('Patch workflow requires workflow_id.');
    const manifestPath = this.manifestPath(id);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const targetPath = this.resolveWorkspacePath(manifest.target_path);
    const backupPath = this.resolvePatchPath(path.relative(this.patchRoot, manifest.backup_path));
    const patchedPath = this.resolvePatchPath(path.relative(this.patchRoot, manifest.patched_path));
    return {
      ...manifest,
      target_path: targetPath,
      backup_path: backupPath,
      patched_path: patchedPath,
    };
  }

  manifestPath(workflowId) {
    return path.join(this.resolvePatchPath(safeWorkflowId(workflowId)), 'manifest.json');
  }

  resolveWorkspacePath(rawPath) {
    const text = String(rawPath || '').trim();
    if (!text) return '';
    const resolved = path.resolve(this.workspaceRoot, text);
    if (!isPathInside(resolved, this.workspaceRoot)) {
      throw new Error('Path is outside the allowed workspace root.');
    }
    return resolved;
  }

  resolvePatchPath(rawPath) {
    const text = String(rawPath || '').trim();
    if (!text) return this.patchRoot;
    const resolved = path.resolve(this.patchRoot, text);
    if (!isPathInside(resolved, this.patchRoot)) {
      throw new Error('Path is outside the patch workflow root.');
    }
    return resolved;
  }
}

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs || DEFAULT_CHECK_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exit_code: 127,
        stdout: '',
        stderr: error.message,
        timed_out: timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exit_code: typeof code === 'number' ? code : timedOut ? 124 : 1,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
        timed_out: timedOut,
      });
    });
  });
}

function publicManifest(manifest, patchRoot) {
  return {
    workflow_id: manifest.workflow_id,
    label: manifest.label || '',
    created_at: manifest.created_at || '',
    target_path: manifest.target_path,
    target_relative_path: manifest.target_relative_path,
    backup_path: manifest.backup_path,
    patched_path: manifest.patched_path,
    backup_relative_path: path.relative(patchRoot, manifest.backup_path).replace(/\\/g, '/'),
    patched_relative_path: path.relative(patchRoot, manifest.patched_path).replace(/\\/g, '/'),
    original_sha256: manifest.original_sha256,
    patched_sha256: manifest.patched_sha256,
    changed: Boolean(manifest.changed),
    applied: Boolean(manifest.applied_at),
    applied_at: manifest.applied_at || '',
  };
}

function workflowIdFor(label) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const slug = normalize(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'patch';
  return `${timestamp}-${slug}-${randomUUID().slice(0, 8)}`;
}

function safeWorkflowId(workflowId) {
  return String(workflowId || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function safeBasename(filePath) {
  return path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '-');
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}
