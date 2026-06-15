# Chrome Sidebar Bridge

The first browser-extension MVP should not run the AI brain inside Chrome.

Use this split:

```text
Chrome sidebar
  reads current tab snapshot
  sends goal + snapshot to local bridge

ArafatAI local bridge
  validates token
  builds bounded prompt
  calls Codex CLI in read-only ephemeral mode
  returns text to sidebar
```

## Run Bridge

```bash
python -m arafatai bridge-server --port 8792 --token arafatai-local-token
```

Optional Codex path:

```bash
set ARAFATAI_CODEX_CLI_PATH=C:\path\to\codex.exe
```

## Load Extension

```text
chrome://extensions
Developer mode
Load unpacked
C:\Users\Arafat\Documents\ArafatAI\extensions\chrome-sidebar
```

## Current Scope

- Page snapshot: URL, title, visible text, clickables, forms, dialogs.
- Codex CLI response through local bridge.
- Sidebar displays response.
- Approved page actions from the sidebar:
  - `Plan Action` asks Codex for a small browser plan and falls back to matching
    visible clickable text from the goal.
  - `Run Action` executes only the currently planned action.
  - Supported action types: `click`, `type`.

Auto browser actions should be added only after approval gates and evals are
ready.

## Troubleshooting

If the sidebar shows this Chrome error:

```text
Could not establish connection. Receiving end does not exist.
```

Reload the unpacked extension from `chrome://extensions`, then reopen the
sidebar. This means the page did not have the extension content script attached
yet. The sidebar also has a fallback that injects `content.js` into normal
`http`, `https`, and `file` tabs before retrying.

For the import-page test:

```text
Goal: import e click koro
Click: Inspect Page
Click: Plan Action
Click: Run Action
```

`Ask Codex` is only for a text answer. It does not click the page.
