import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function shorten(value, limit) {
  const text = String(value || '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactClickable(item) {
  if (!isPlainObject(item)) return null;
  return {
    ref: item.ref || '',
    text: shorten(item.text, 140),
    selector: shorten(item.selector, 180),
    role: item.role || '',
    type: item.type || '',
    href: shorten(item.href, 220),
  };
}

function compactForm(form) {
  if (!isPlainObject(form)) return null;
  const fields = Array.isArray(form.fields) ? form.fields : [];
  return {
    selector: shorten(form.selector, 180),
    action: shorten(form.action, 220),
    method: form.method || '',
    fields: fields.slice(0, 20).filter(isPlainObject).map((field) => ({
      ref: field.ref || '',
      selector: shorten(field.selector, 180),
      name: field.name || '',
      type: field.type || '',
      placeholder: shorten(field.placeholder, 120),
    })),
  };
}

export function compactPage(page = {}) {
  const clickables = Array.isArray(page.clickables) ? page.clickables : [];
  const forms = Array.isArray(page.forms) ? page.forms : [];
  const dialogs = Array.isArray(page.dialogs) ? page.dialogs : [];

  return {
    url: page.url || '',
    title: page.title || '',
    viewport: isPlainObject(page.viewport) ? page.viewport : {},
    accessibility_tree: shorten(page.accessibility_tree, 6000),
    visible_text: shorten(page.visible_text, 1200),
    clickables: clickables.slice(0, 80).map(compactClickable).filter(Boolean),
    forms: forms.slice(0, 10).map(compactForm).filter(Boolean),
    dialogs: dialogs.slice(0, 8).filter(isPlainObject).map((dialog) => ({
      selector: shorten(dialog.selector, 180),
      text: shorten(dialog.text, 400),
    })),
  };
}

export function compactTaskState(taskState = {}) {
  const observations = Array.isArray(taskState.observations) ? taskState.observations : [];
  return {
    task_id: taskState.task_id || '',
    step: taskState.step || '',
    max_steps: taskState.max_steps || '',
    observations: observations.slice(-8).filter(isPlainObject).map((observation) => ({
      kind: observation.kind || '',
      status: observation.status || '',
      message: shorten(observation.message, 300),
      result: isPlainObject(observation.result) ? observation.result : {},
    })),
  };
}

function compactConversationMemory(memory = {}) {
  if (!isPlainObject(memory)) return {};
  const turns = Array.isArray(memory.recent_turns) ? memory.recent_turns : [];
  return {
    summary: shorten(memory.summary, 1600),
    recent_turns: turns.slice(-10).filter(isPlainObject).map((entry) => ({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      text: shorten(entry.text, 500),
    })),
    last_page: isPlainObject(memory.last_page) ? {
      url: shorten(memory.last_page.url, 260),
      title: shorten(memory.last_page.title, 180),
      visible_text_sample: shorten(memory.last_page.visible_text_sample, 500),
      captured_at: memory.last_page.captured_at || '',
    } : null,
    last_task: isPlainObject(memory.last_task) ? {
      goal: shorten(memory.last_task.goal, 700),
      reply: shorten(memory.last_task.reply, 900),
      status: memory.last_task.status || '',
      task_id: memory.last_task.task_id || '',
      finished_at: memory.last_task.finished_at || '',
    } : null,
    updated_at: memory.updated_at || '',
  };
}

function compactTaskMemory(memory = {}) {
  if (!isPlainObject(memory)) return {};
  const plans = Array.isArray(memory.recent_plans) ? memory.recent_plans : [];
  const observations = Array.isArray(memory.recent_observations) ? memory.recent_observations : [];
  const successfulActions = Array.isArray(memory.successful_actions) ? memory.successful_actions : [];
  const failedActions = Array.isArray(memory.failed_actions) ? memory.failed_actions : [];

  return {
    task_id: memory.task_id || '',
    goal: shorten(memory.goal, 700),
    status: memory.status || '',
    history: Array.isArray(memory.history) ? memory.history.slice(-8) : [],
    last_page: isPlainObject(memory.last_page) ? memory.last_page : null,
    recent_plans: plans.slice(-5),
    recent_observations: observations.slice(-10),
    successful_actions: successfulActions.slice(-6),
    failed_actions: failedActions.slice(-6),
  };
}

function compactAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter(isPlainObject)
    .slice(0, 8)
    .map((attachment, index) => ({
      order: index + 1,
      source_order: attachment.order || index + 1,
      source: attachment.source || 'attachment',
      name: attachment.name || `image-${index + 1}`,
      mime_type: attachment.mime_type || attachment.type || '',
      size: attachment.size || 0,
      path: attachment.path || '',
    }));
}

export function buildExtensionPrompt(body = {}) {
  const mode = String(body.mode || 'chat');
  const goal = String(body.goal || body.message || '');
  const rawPage = isPlainObject(body.page) ? body.page : {};
  const history = Array.isArray(body.history) ? body.history : [];
  const conversationMemory = compactConversationMemory(body.conversation_memory);
  const taskMemory = compactTaskMemory(body.task_memory);
  const rawTaskState = isPlainObject(body.task_state) ? body.task_state : {};
  const approvalPolicy = String(body.approval_policy || 'ask');
  const attachments = compactAttachments(body.attachments);

  const instructions = [
    'You are FLUID running behind a local Chrome sidebar extension.',
    'Codex CLI is only the temporary testing provider. Arafat will replace this with his own AI later through the same JSON contract.',
    'Do not reveal hidden chain-of-thought. Use only concise, observable reasoning_summary items.',
    'Do not edit files, run shell commands, use browser tools, or claim that an action was completed.',
    'Use only the supplied page snapshot, conversation_memory, task_memory, history, and task_state observations.',
    'You are stateless between requests. Treat conversation_memory and task_memory as your durable memory for follow-up words like "eta", "ebar", "same", and "current tab".',
    'Before proposing an action, compare it with task_memory.recent_plans, successful_actions, failed_actions, and recent_observations.',
    'Do not repeat the same failed target/action unless the latest page snapshot or screenshot shows a meaningful change.',
    'If the page snapshot is insufficient or the target is ambiguous, ask a short question instead of inventing an action.',
    'Any browser action must be proposed only; the extension executes it and sends back observations.',
    'Keep the reply concise and in the same language style as the user.',
    'When uploaded images exist, read them in the given order. If the user says first/second/third image, map that to attachment order 1/2/3.',
    'When a current-tab screenshot exists, use it as visual evidence together with the DOM snapshot. Prefer visible screenshot evidence when DOM text/clickables miss a visually obvious target.',
  ];

  if (['browser_plan', 'agent_chat', 'agent_plan', 'agent_task'].includes(mode)) {
    instructions.push(
      'Return strict JSON only.',
      'Schema: {"reply":"short user-facing answer","reasoning_summary":["1-4 short evidence-based bullets"],"questions":["short question if needed"],"actions":[{"type":"navigate|search|click|type|press|wait|observe","target":"ref id, selector, URL, or search query","value":"optional query/text/URL/key/wait ms","mode":"web|images","reason":"why this action is safe and relevant"}],"done":true|false,"needs_approval":true|false}',
      'The JSON must be valid: escape every newline inside reply strings as \\n, escape quotes, and never print Markdown or code outside the JSON object.',
      'When the user asks for code, fixing code, exact code, or "code dao", put the final code in exactly one fenced code block inside reply. Do not split JS and CSS into separate code blocks; use path comments inside one block if multiple files are needed.',
      'Code answers must be production-style: minimal scope, no intervals unless necessary, no broad selectors when specific selectors exist, and include assumptions before the single code block if needed.',
      'Use ref ids from page.accessibility_tree when available, for example target: "ref_12".',
      'Use selectors or exact visible text from the supplied page snapshot only when no ref id exists.',
      'For click actions, never use generic selectors like "a", "button", "input", "textarea", "select", or "[role=button]". Use a ref id or target like "text=Exact visible label".',
      'For YouTube/video/song/play requests, do not click unrelated controls from the current page. Prefer navigating to a YouTube search/results/watch URL from the snapshot hrefs.',
      'For YouTube watch links, prefer a navigate action to the supplied href instead of clicking a ref id that may become stale.',
      'Do not set done true for a play request just because a YouTube results page is open; done requires an active matching watch page or explicit observation.',
      'For multi-step tasks, choose the next 1-3 safe actions, then wait for observations in task_state.',
      'Use previous task_state observations to decide whether the task is done or what to do next.',
      'Set done true only when observations or page snapshot show the requested task is complete.',
      'If credentials, payment, CAPTCHA, destructive changes, publishing, or irreversible admin changes are needed, ask a question and return no actions.',
      'For Chrome internal pages such as chrome://newtab, do not ask for a DOM snapshot; use search or navigate when the user asks for it.',
      'If approval_policy is chat-only, keep actions empty and answer conversationally.',
      'If approval_policy is plan-only, still return proposed actions but needs_approval must be true.',
    );
  }

  const context = {
    mode,
    goal,
    page: compactPage(rawPage),
    history: history.slice(-6),
    conversation_memory: conversationMemory,
    task_memory: taskMemory,
    attachments,
    task_state: compactTaskState(rawTaskState),
    approval_policy: approvalPolicy,
  };

  return [
    ...instructions,
    '',
    'Request JSON:',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(commandName) {
  const pathValue = process.env.PATH || process.env.Path || '';
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, commandName.endsWith(ext) ? commandName : `${commandName}${ext}`);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return '';
}

async function findVsCodeCodex() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return '';

  const extensionRoot = path.join(home, '.vscode', 'extensions');
  try {
    const entries = await readdir(extensionRoot, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
      .map((entry) => path.join(extensionRoot, entry.name, 'bin', 'windows-x86_64', 'codex.exe'))
      .sort()
      .reverse();
    for (const candidate of candidates) {
      if (await fileExists(candidate)) return candidate;
    }
  } catch {
    return '';
  }
  return '';
}

export async function findCodexCommand(configured = '') {
  const candidates = [
    configured,
    process.env.ARAFATAI_CODEX_CLI_PATH,
    process.env.CODEX_CLI_PATH,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  return await findOnPath('codex') || await findVsCodeCodex();
}

export async function reasonWithCodex(body = {}, config = {}) {
  const codex = await findCodexCommand(config.codexPath || '');
  if (!codex) {
    return {
      ok: false,
      text: 'Codex CLI was not found. Set ARAFATAI_CODEX_CLI_PATH or install/open the Codex CLI provider.',
      source: 'codex-cli',
      error: 'codex_not_found',
    };
  }

  const cwd = path.resolve(config.cwd || process.cwd());
  const timeoutMs = Math.max(1000, Number(config.timeoutSeconds || 120) * 1000);
  const prompt = buildExtensionPrompt(body);
  const imagePaths = compactAttachments(body.attachments)
    .map((attachment) => attachment.path)
    .filter(Boolean);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'arafatai-codex-'));
  const outFile = path.join(tempDir, 'last-message.txt');
  const args = [
    '-a',
    'never',
    'exec',
    ...imagePaths.flatMap((imagePath) => ['--image', imagePath]),
    '-C',
    cwd,
    '--sandbox',
    config.sandbox || 'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    '--output-last-message',
    outFile,
    '-',
  ];

  try {
    const completed = await runCodexProcess(codex, args, prompt, cwd, timeoutMs);
    let text = '';
    try {
      text = (await readFile(outFile, 'utf8')).trim();
    } catch {
      text = '';
    }
    if (!text) text = completed.stdout.trim();

    if (completed.timedOut) {
      return {
        ok: false,
        text: 'Codex CLI timed out.',
        source: 'codex-cli',
        error: 'timeout',
      };
    }

    if (completed.code !== 0 && !text) {
      return {
        ok: false,
        text: 'Codex CLI failed.',
        source: 'codex-cli',
        error: (completed.stderr || 'codex_failed').trim().slice(0, 500),
      };
    }

    if (!text) {
      return {
        ok: false,
        text: 'Codex CLI returned an empty response.',
        source: 'codex-cli',
        error: 'empty_response',
      };
    }

    return {
      ok: true,
      text,
      source: 'codex-cli',
      error: null,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runCodexProcess(command, args, input, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message || stderr, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });

    child.stdin.end(input);
  });
}
