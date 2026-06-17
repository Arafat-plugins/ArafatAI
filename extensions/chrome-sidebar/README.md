# FLUID Chrome Sidebar MVP

This extension is the browser-side testing shell for FLUID.

It does not run the AI brain inside Chrome. The extension reads the current tab,
creates/updates a backend task checkpoint, asks the local bridge for the next
step, executes safe browser actions, and observes again.

```text
Chrome sidebar
  -> content script accessibility snapshot
  -> local task checkpoint
  -> local Node bridge
  -> Codex CLI testing provider for next action
  -> execute safe browser action
  -> observe again
```

## Start The Local Bridge

From this repo:

```powershell
node tools\sidebar-bridge-node\src\server.mjs --port 8792 --token arafatai-local-token --cwd . --provider codex --timeout 120
```

Or double-click:

```text
tools\sidebar-bridge-node\start-bridge.cmd
```

This Node bridge does not require Python packages. The older Python code can
wait for later development; current sidebar testing uses the Node bridge plus
Codex CLI.

## Load The Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select `extensions/chrome-sidebar`.
5. Open any page and click the FLUID extension/sidebar.

## Current Scope

- Reads URL, title, accessibility tree, clickables, forms, and dialogs.
- Uses stable `ref_*` element targets when possible.
- Runs a bounded action-observation loop.
- Starts AI planning asynchronously and polls task checkpoints.
- Shows real progress trace messages in the chat for snapshot, planner, action,
  and result events.
- Uses Codex CLI as the temporary testing planner through the Node bridge.
- Supported actions: `navigate`, `search`, `click`, `type`, `press`, `wait`, `observe`.
- Saves task checkpoints in `runs/bridge-tasks/`.
- Supports ordered image uploads from the composer. The Node bridge saves images
  under `runs/bridge-attachments/{task_id}/` and passes them to Codex CLI with
  `--image` in the same order shown in the sidebar.
- Captures the current visible tab only for visual/action tasks, passes it to
  Codex CLI as visual evidence, and shows a screenshot card only when the user
  explicitly asks to show/open a screenshot.

Risky actions such as delete/payment/deploy/reset/publish are blocked locally
and should ask the user before continuing.
