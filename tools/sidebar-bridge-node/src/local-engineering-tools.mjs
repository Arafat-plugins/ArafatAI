import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TEXT_BYTES = 100000;
const DEFAULT_TEXT_BYTES = 20000;
const MAX_OUTPUT_BYTES = 40000;

export async function runFileRead(input = {}, options = {}) {
  const workspaceRoot = workspaceRootFor(options);
  const targetPath = resolveWorkspacePath(input.path || input.file || input.target_path || input.targetPath, workspaceRoot);
  const maxBytes = safeInteger(input.max_bytes ?? input.maxBytes, DEFAULT_TEXT_BYTES, 1, MAX_TEXT_BYTES);
  const fileStat = await stat(targetPath);
  if (!fileStat.isFile()) throw new Error('file_read target must be a file.');
  const raw = await readFile(targetPath);
  const sample = raw.subarray(0, maxBytes).toString('utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  const relativePath = relativeWorkspacePath(targetPath, workspaceRoot);

  return {
    ok: true,
    status: 200,
    result: {
      path: relativePath,
      bytes: fileStat.size,
      truncated: fileStat.size > maxBytes,
      text_sample: sample,
      sha256: hash,
    },
    evidence: {
      type: 'file',
      title: `Read file: ${relativePath}`,
      summary: `Read ${Math.min(fileStat.size, maxBytes)} of ${fileStat.size} byte(s) from ${relativePath}.`,
    },
    payload: {
      tool: 'file_read',
      input: { path: relativePath, max_bytes: maxBytes },
      result: {
        path: relativePath,
        bytes: fileStat.size,
        truncated: fileStat.size > maxBytes,
        text_sample: sample,
        sha256: hash,
      },
    },
  };
}

export async function runFileSearch(input = {}, options = {}) {
  const workspaceRoot = workspaceRootFor(options);
  const pattern = normalizeText(input.pattern || input.query || '');
  if (!pattern) throw new Error('file_search requires pattern.');
  if (pattern.length > 160) throw new Error('file_search pattern is too long.');

  const scope = input.path || input.scope || '.';
  const scopePath = resolveWorkspacePath(scope, workspaceRoot);
  const args = [
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--max-count',
    String(safeInteger(input.max_count ?? input.maxCount, 80, 1, 200)),
  ];
  const glob = normalizeText(input.glob || '');
  if (glob) args.push('--glob', glob);
  args.push(pattern, scopePath);

  const command = await runBoundedCommand('rg', args, {
    cwd: workspaceRoot,
    timeoutMs: safeInteger(input.timeout_ms ?? input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000),
  });
  const lines = splitLines(command.stdout).slice(0, safeInteger(input.max_results ?? input.maxResults, 80, 1, 200));
  const relativeLines = lines.map((line) => relativizeRgLine(line, workspaceRoot));

  return {
    ok: command.exit_code === 0 || command.exit_code === 1,
    status: command.exit_code === 0 || command.exit_code === 1 ? 200 : 500,
    result: {
      pattern,
      scope: relativeWorkspacePath(scopePath, workspaceRoot),
      matches: relativeLines,
      match_count: relativeLines.length,
      exit_code: command.exit_code,
      stderr: command.stderr,
      timed_out: command.timed_out,
    },
    error: command.exit_code === 0 || command.exit_code === 1 ? null : 'file_search_failed',
    evidence: {
      type: 'file_search',
      title: `File search: ${pattern}`,
      summary: command.exit_code === 1
        ? `No matches for "${pattern}" under ${relativeWorkspacePath(scopePath, workspaceRoot)}.`
        : `Found ${relativeLines.length} match line(s) for "${pattern}".`,
    },
    payload: {
      tool: 'file_search',
      input: { pattern, scope: relativeWorkspacePath(scopePath, workspaceRoot), glob },
      result: {
        matches: relativeLines,
        exit_code: command.exit_code,
        stderr: command.stderr,
      },
    },
  };
}

export async function runGitStatus(input = {}, options = {}) {
  const workspaceRoot = workspaceRootFor(options);
  const cwd = resolveWorkspacePath(input.cwd || '.', workspaceRoot);
  const result = await runBoundedCommand('git', ['status', '--short', '--branch'], {
    cwd,
    timeoutMs: safeInteger(input.timeout_ms ?? input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000),
  });
  return commandEvidenceResult({
    tool: 'git_status',
    type: 'git',
    title: 'Git status',
    summary: result.exit_code === 0 ? 'Read git status.' : 'Git status failed.',
    command: ['git', 'status', '--short', '--branch'],
    result,
  });
}

export async function runGitDiffSummary(input = {}, options = {}) {
  const workspaceRoot = workspaceRootFor(options);
  const cwd = resolveWorkspacePath(input.cwd || '.', workspaceRoot);
  const statResult = await runBoundedCommand('git', ['diff', '--stat'], {
    cwd,
    timeoutMs: safeInteger(input.timeout_ms ?? input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000),
  });
  const nameResult = await runBoundedCommand('git', ['diff', '--name-only'], {
    cwd,
    timeoutMs: safeInteger(input.timeout_ms ?? input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000),
  });
  const ok = statResult.exit_code === 0 && nameResult.exit_code === 0;
  return {
    ok,
    status: ok ? 200 : 500,
    result: {
      command: ['git', 'diff', '--stat'],
      exit_code: statResult.exit_code,
      stdout: statResult.stdout,
      stderr: statResult.stderr || nameResult.stderr,
      files: splitLines(nameResult.stdout),
      timed_out: statResult.timed_out || nameResult.timed_out,
    },
    error: ok ? null : 'git_diff_failed',
    evidence: {
      type: 'git',
      title: 'Git diff summary',
      summary: ok ? `${splitLines(nameResult.stdout).length} changed tracked file(s) in git diff.` : 'Git diff summary failed.',
    },
    payload: {
      tool: 'git_diff_summary',
      result: {
        stdout: statResult.stdout,
        files: splitLines(nameResult.stdout),
        stderr: statResult.stderr || nameResult.stderr,
      },
    },
  };
}

export async function runPhpLint(input = {}, options = {}) {
  const workspaceRoot = workspaceRootFor(options);
  const targetPath = resolveWorkspacePath(input.path || input.file || input.target_path || input.targetPath, workspaceRoot);
  const command = input.php || 'php';
  const result = await runBoundedCommand(command, ['-l', targetPath], {
    cwd: workspaceRoot,
    timeoutMs: safeInteger(input.timeout_ms ?? input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000),
  });
  return commandEvidenceResult({
    tool: 'php_lint',
    type: 'lint',
    title: `PHP lint: ${relativeWorkspacePath(targetPath, workspaceRoot)}`,
    summary: `php -l exited with ${result.exit_code}.`,
    command: [command, '-l', relativeWorkspacePath(targetPath, workspaceRoot)],
    result,
    okStatus: 200,
    failStatus: 422,
  });
}

export async function runNodeTest(input = {}, options = {}) {
  const workspaceRoot = workspaceRootFor(options);
  const cwd = resolveWorkspacePath(input.cwd || '.', workspaceRoot);
  const command = input.command || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const args = Array.isArray(input.args) && input.args.length ? input.args.map(String) : ['test'];
  if (args.some((arg) => /[;&|<>]/.test(arg))) throw new Error('node_test args contain unsupported shell metacharacters.');
  const result = await runBoundedCommand(command, args, {
    cwd,
    timeoutMs: safeInteger(input.timeout_ms ?? input.timeoutMs, 60000, 1000, 180000),
  });
  return commandEvidenceResult({
    tool: 'node_test',
    type: 'test',
    title: `Node test: ${relativeWorkspacePath(cwd, workspaceRoot) || '.'}`,
    summary: `${command} ${args.join(' ')} exited with ${result.exit_code}.`,
    command: [command, ...args],
    result,
    okStatus: 200,
    failStatus: 422,
  });
}

function commandEvidenceResult({ tool, type, title, summary, command, result, okStatus = 200, failStatus = 500 }) {
  const ok = result.exit_code === 0;
  return {
    ok,
    status: ok ? okStatus : failStatus,
    result: {
      command,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      timed_out: result.timed_out,
    },
    error: ok ? null : `${tool}_failed`,
    evidence: {
      type,
      title,
      summary,
    },
    payload: {
      tool,
      result: {
        command,
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        timed_out: result.timed_out,
      },
    },
  };
}

function runBoundedCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        stderr.push(chunk);
        stderrBytes += chunk.length;
      }
    });
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
    stdout: Buffer.concat(stdout).subarray(0, MAX_OUTPUT_BYTES).toString('utf8').trim(),
    stderr: Buffer.concat(stderr).subarray(0, MAX_OUTPUT_BYTES).toString('utf8').trim(),
    timed_out: timedOut,
  });
});
  });
}

function workspaceRootFor(options = {}) {
  return path.resolve(options.workspaceRoot || process.cwd());
}

function resolveWorkspacePath(rawPath, workspaceRoot) {
  const text = String(rawPath || '').trim();
  if (!text) throw new Error('Tool input requires a workspace path.');
  const resolved = path.resolve(workspaceRoot, text);
  if (!isPathInside(resolved, workspaceRoot)) {
    throw new Error('Path is outside the allowed workspace root.');
  }
  return resolved;
}

function relativeWorkspacePath(targetPath, workspaceRoot) {
  const relative = path.relative(workspaceRoot, targetPath).replace(/\\/g, '/');
  return relative || '.';
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativizeRgLine(line, workspaceRoot) {
  const normalized = String(line || '');
  const match = normalized.match(/^(.+?):(\d+)(?::(.*))?$/);
  if (!match) return normalized;
  const maybePath = match[1];
  const absolute = path.isAbsolute(maybePath) ? maybePath : path.resolve(workspaceRoot, maybePath);
  if (isPathInside(absolute, workspaceRoot)) {
    return `${relativeWorkspacePath(absolute, workspaceRoot)}${normalized.slice(maybePath.length)}`;
  }
  return normalized;
}

function splitLines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function safeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
