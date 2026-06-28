# FLUID Node Sidebar Bridge

This bridge serves the same local HTTP API as the original Python bridge, but
uses only built-in Node.js modules and Codex CLI for testing. It is the simpler
path for running the Chrome sidebar without installing Python packages.

## Run

From the repo root:

```powershell
node tools\sidebar-bridge-node\src\server.mjs --port 8792 --token arafatai-local-token --cwd . --provider codex --timeout 45
```

Or double-click:

```text
tools\sidebar-bridge-node\start-bridge.cmd
```

Then reload the unpacked Chrome extension from `extensions/chrome-sidebar`.

To route planning through the Python-first core while keeping this same Node
HTTP bridge for Chrome/browser work:

```powershell
node tools\sidebar-bridge-node\src\server.mjs --port 8792 --token arafatai-local-token --cwd . --provider python-core --python-path D:\ArafatTools\venvs\ArafatAI\Scripts\python.exe --timeout 45 --allow-local-fallback
```

The Python side exposes the same provider response contract through:

```powershell
python -m arafatai sidebar-reason < request.json
```

## Notes

- No Python is required for this bridge.
- Default planning provider is Codex CLI; `--provider local` keeps testing
  dependency-free, and `--provider python-core` delegates planning policy to the
  Python ArafatAI core through the same JSON contract.
- The Chrome extension still talks to `http://127.0.0.1:8792`.
- Task checkpoints are saved in `runs/bridge-tasks/`.
- Uploaded images are saved in `runs/bridge-attachments/{task_id}/` and passed
  to Codex CLI with `--image` in user-selected order.
- WordPress read-only support helpers live in `src/wordpress-tools.mjs`. They
  preserve user-provided login routes, follow redirects with cookies, parse
  login forms, and read active theme/plugin evidence from admin HTML. They do
  not perform file edits or live setting changes.
- Tools are exposed through `POST /tasks/{id}/tool` and are logged to the task
  evidence folder. The read-only/local-evidence allowlist is `http_get`,
  `wp_active_theme`, `wp_plugins`, `wp_overview`, `file_read`, `file_search`,
  `git_status`, `git_diff_summary`, `php_lint`, `node_test`, and
  `chrome_cdp_check`.
- Local engineering tools are workspace-scoped and bounded. They can read a
  compact file sample, search with `rg`, inspect git status/diff summaries, run
  PHP lint on one file, or run an explicit Node test command without a shell.
  Paths outside the configured bridge `--cwd` are rejected.
- Patch workflow tools are `file_change_prepare`, `file_change_check`, and
  `file_change_apply`. Prepare creates a backup and patched copy under
  `runs/patch-workflows/`; apply refuses to change the target without
  `approved: true` and refuses stale applies if the target changed after backup.
  Generic write/shell/deploy tool names remain blocked before execution.
- Browser verification uses `chrome_cdp_check` against a running Chrome remote
  debugging endpoint, usually `http://127.0.0.1:9222`. It can set viewport,
  geolocation, run a DOM assertion, collect compact console/network evidence,
  and save screenshots under `runs/browser-evidence/`.
- Current-tab screenshots from the sidebar are saved only for visual/action
  prompts and passed to Codex CLI after user-uploaded images, so visual targets
  missed by the DOM snapshot can still be understood without cluttering normal
  chat.
- This is intentionally dependency-free so it can later be bundled into a
  Windows executable/installer.
- For fast deterministic unit testing only, use `--provider local`.
