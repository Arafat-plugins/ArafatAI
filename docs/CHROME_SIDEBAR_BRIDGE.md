# Chrome Sidebar Bridge

The first browser-extension MVP should not run the AI brain inside Chrome.

Use this split:

```text
Chrome sidebar
  reads current tab snapshot
  sends goal + snapshot to local bridge

ArafatAI local bridge
  validates token
  builds bounded agent-contract prompt
  calls Codex CLI in read-only ephemeral mode for testing
  returns text to sidebar
```

Codex is only the temporary provider. The extension is built around a stable
JSON contract so Arafat's own AI can replace Codex later.

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
- Chat-style sidebar response through local bridge.
- Visible `reasoning_summary`, not hidden chain-of-thought.
- Question list when the AI needs clarification.
- Approved page actions from the sidebar:
  - `Plan` asks the provider for a small browser plan and falls back to matching
    visible clickable text from the goal.
  - `Approve & Run` executes only the currently planned action.
  - Supported action types: `click`, `type`.

Auto browser actions should be added only after approval gates and evals are
ready.

## Agent JSON Contract

```json
{
  "reply": "short user-facing answer",
  "reasoning_summary": ["short evidence-based summary"],
  "questions": ["ask when the next action is unclear"],
  "actions": [
    {
      "type": "click",
      "target": "text=IMPORT FROM",
      "value": "",
      "reason": "visible page text matches the user's import request"
    }
  ],
  "needs_approval": true
}
```

Do not put hidden/private chain-of-thought into `reasoning_summary`. Keep it as
the visible reason a human needs to approve the next action.

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
Click: Inspect
Click: Plan
Click: Approve & Run
```

`Ask` can answer and propose actions. It does not execute actions. Only
`Approve & Run` clicks or types into the page.
