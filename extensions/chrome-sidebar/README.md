# AQL AI Chrome Sidebar MVP

This extension is the browser-side testing shell for AQL AI.

It does not run the AI brain inside Chrome. The extension reads the current tab,
creates/updates a backend task checkpoint, asks the local bridge for the next
step, executes safe browser actions, and observes again.

```text
Chrome sidebar
  -> content script accessibility snapshot
  -> local task checkpoint
  -> async Codex CLI provider or fast Python local planner for next action
  -> execute safe browser action
  -> observe again
```

## Start The Local Bridge

From this repo:

```bash
python -m arafatai bridge-server --port 8792 --token arafatai-local-token
```

If Codex CLI is not found automatically:

```bash
set ARAFATAI_CODEX_CLI_PATH=C:\path\to\codex.exe
python -m arafatai bridge-server --port 8792 --token arafatai-local-token
```

## Load The Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select `extensions/chrome-sidebar`.
5. Open any page and click the AQL AI extension/sidebar.

## Current Scope

- Reads URL, title, accessibility tree, clickables, forms, and dialogs.
- Uses stable `ref_*` element targets when possible.
- Runs a bounded action-observation loop.
- Starts AI planning asynchronously and polls task checkpoints.
- Shows real progress trace messages in the chat for snapshot, planner, action,
  and result events.
- Uses a deterministic local planner for obvious safe actions such as opening
  YouTube or Google image search when the temporary Codex provider is slow.
- Supported actions: `navigate`, `search`, `click`, `type`, `press`, `wait`, `observe`.
- Saves task checkpoints in `runs/bridge-tasks/`.

Risky actions such as delete/payment/deploy/reset/publish are blocked locally
and should ask the user before continuing.
