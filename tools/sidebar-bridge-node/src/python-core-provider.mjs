import { spawn } from 'node:child_process';
import path from 'node:path';

export async function reasonWithPythonCore(body = {}, config = {}) {
  const command = config.pythonCommand || config.pythonPath || process.env.ARAFATAI_PYTHON || process.env.PYTHON || 'python';
  const args = Array.isArray(config.pythonArgs) && config.pythonArgs.length
    ? config.pythonArgs
    : ['-m', 'arafatai', 'sidebar-reason'];
  const timeoutMs = Number(config.timeoutSeconds || 45) * 1000;

  try {
    const cwd = config.cwd || process.cwd();
    const completed = await runJsonProcess(command, args, body, {
      cwd,
      env: pythonEnv(cwd),
      timeoutMs,
    });
    if (completed.timedOut) {
      return {
        ok: false,
        text: 'Python core timed out.',
        source: 'python-core',
        error: 'timeout',
      };
    }
    if (completed.exitCode !== 0 && !completed.stdout.trim()) {
      return {
        ok: false,
        text: 'Python core failed.',
        source: 'python-core',
        error: completed.stderr.trim() || `exit_${completed.exitCode}`,
      };
    }

    const parsed = parseProviderResponse(completed.stdout);
    if (!parsed) {
      return {
        ok: false,
        text: 'Python core returned invalid JSON.',
        source: 'python-core',
        error: completed.stdout.trim() || completed.stderr.trim() || 'invalid_json',
      };
    }

    return {
      ok: parsed.ok !== false,
      text: String(parsed.text || ''),
      source: String(parsed.source || 'python-core'),
      error: parsed.error ? String(parsed.error) : null,
    };
  } catch (error) {
    return {
      ok: false,
      text: 'Python core could not be started.',
      source: 'python-core',
      error: error?.message || String(error),
    };
  }
}

function runJsonProcess(command, args, body, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs || 45000);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: typeof code === 'number' ? code : timedOut ? 124 : 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    });

    child.stdin.end(JSON.stringify(body || {}));
  });
}

function pythonEnv(cwd) {
  const srcPath = path.join(cwd || process.cwd(), 'src');
  const current = process.env.PYTHONPATH || '';
  return {
    ...process.env,
    PYTHONPATH: current ? `${srcPath}${path.delimiter}${current}` : srcPath,
  };
}

function parseProviderResponse(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
