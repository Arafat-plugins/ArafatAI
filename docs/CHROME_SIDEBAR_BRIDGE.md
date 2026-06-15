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
- No auto click/type yet.

Auto browser actions should be added only after approval gates and evals are
ready.
