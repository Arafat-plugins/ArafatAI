# FLUID Node Sidebar Bridge

This bridge serves the same local HTTP API as the original Python bridge, but
uses only built-in Node.js modules and Codex CLI for testing. It is the simpler
path for running the Chrome sidebar without installing Python packages.

## Run

From the repo root:

```powershell
node tools\sidebar-bridge-node\src\server.mjs --port 8792 --token arafatai-local-token --cwd . --provider codex --timeout 120
```

Or double-click:

```text
tools\sidebar-bridge-node\start-bridge.cmd
```

Then reload the unpacked Chrome extension from `extensions/chrome-sidebar`.

## Notes

- No Python is required for this bridge.
- Default planning provider is Codex CLI.
- The Chrome extension still talks to `http://127.0.0.1:8792`.
- Task checkpoints are saved in `runs/bridge-tasks/`.
- Uploaded images are saved in `runs/bridge-attachments/{task_id}/` and passed
  to Codex CLI with `--image` in user-selected order.
- Current-tab screenshots from the sidebar are saved only for visual/action
  prompts and passed to Codex CLI after user-uploaded images, so visual targets
  missed by the DOM snapshot can still be understood without cluttering normal
  chat.
- This is intentionally dependency-free so it can later be bundled into a
  Windows executable/installer.
- For fast deterministic unit testing only, use `--provider local`.
