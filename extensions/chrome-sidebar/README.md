# ArafatAI Chrome Sidebar MVP

This extension is the browser-side testing shell for ArafatAI.

It does not run the AI brain inside Chrome. The extension reads the current tab
snapshot and sends it to the local ArafatAI bridge:

```text
Chrome sidebar -> content script snapshot -> http://127.0.0.1:8792/reason -> Codex CLI
```

## Start The Local Bridge

From the ArafatAI repo:

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
5. Open any page and click the ArafatAI extension/sidebar.

## Current Scope

- Reads URL, title, visible text, clickables, forms, and dialogs.
- Sends snapshot and goal to local bridge.
- Shows Codex CLI response in the sidebar.
- Does not auto-click/type yet.

Auto actions should be added only after approval gates and evals are ready.

