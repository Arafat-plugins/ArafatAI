# ArafatAI

Personal AI operating system for Arafat.

Goal:

```text
Python-first AI core
multiple specialized agents
browser/file/shell/git tools
memory and lessons
evaluation before changes
PR-gated self-improvement
human approval for risky actions
```

## Current Stage

This repo starts as a clean scaffold. Implementation will grow step by step.

```text
Phase 1: core structure and docs
Phase 2: browser tool adapter
Phase 3: browser snapshot, memory, and eval basics
Phase 4: Tiny GPT learning module
Phase 5: multi-agent workflow
Phase 6: PR-gated self-improvement
```

## Rule

The AI can propose code, create branches, run tests, and prepare PR summaries.

The AI must not auto-merge or perform risky actions without human approval.

## Structure

```text
src/arafatai/
  agents/       specialized agents
  brain/        LLM client and prompts
  tools/        browser, shell, file, git adapters
  memory/       memory interfaces
  evals/        quality checks and scorecards
docs/           architecture and roadmap
tests/          automated tests
```

## First Commands

```bash
python -m pip install -e .
python -m arafatai --help
python -m pytest
```

Windows D-drive setup for this machine:

```text
docs/LOCAL_SETUP_WINDOWS.md
```

## Browser Action Example

This repo is Python-first, but the first browser hand wraps the existing Node
browser-agent MVP.

```bash
python -m arafatai browser-action \
  --url "http://user-sites.local/en/add-listing/" \
  --action "{\"type\":\"click\",\"target\":\"text=Here\"}" \
  --action "{\"type\":\"screenshot\",\"value\":\"runs/after-click.png\"}" \
  --yes
```

On Windows PowerShell, prefer an action file to avoid JSON quote escaping:

```json
[
  { "type": "click", "target": "text=Here" },
  { "type": "screenshot", "value": "runs/after-click.png" }
]
```

```bash
python -m arafatai browser-action \
  --url "http://user-sites.local/en/add-listing/" \
  --actions-file examples/browser-actions/add-listing-modal.json \
  --yes
```

Environment override:

```bash
ARAFATAI_BROWSER_AGENT_NODE="C:/path/to/browser-agent-mvp"
```

Risky actions are blocked unless `--yes` is passed.

## Local Codex Bridge For Sidebar Testing

The Chrome sidebar extension talks to a local ArafatAI bridge. The bridge then
calls Codex CLI in read-only, ephemeral mode.

```bash
python -m arafatai bridge-server --port 8792 --token arafatai-local-token
```

If Codex CLI is not found automatically:

```bash
set ARAFATAI_CODEX_CLI_PATH=C:\path\to\codex.exe
python -m arafatai bridge-server --port 8792 --token arafatai-local-token
```

Extension folder:

```text
extensions/chrome-sidebar
```

Load it from `chrome://extensions` with Developer mode -> Load unpacked.

Sidebar behavior:

```text
Message box -> chat with the local bridge
Enter       -> send
Shift+Enter -> new line
```

The sidebar uses a provider-independent agent contract:

```json
{
  "reply": "short user-facing answer",
  "reasoning_summary": ["visible evidence-based summary, not hidden chain-of-thought"],
  "questions": ["ask when the target or intent is unclear"],
  "actions": [
    { "type": "click", "target": "text=IMPORT FROM", "reason": "why this matches the request" }
  ],
  "needs_approval": true
}
```

Codex is only the temporary testing provider. Later, ArafatAI's own model can
return the same JSON shape and the sidebar will keep working.

The current sidebar is chat-only. Browser actions can still be added behind a
clean approval flow later, but they are not shown in the simple chat UI.

## Browser Snapshot Example

Snapshot reads the page like an agent: URL, title, visible text, clickables,
forms, dialogs, and notices.

```bash
python -m arafatai browser-snapshot \
  --url "http://user-sites.local/en/add-listing/" \
  --output "runs/add-listing-snapshot.json"
```

Then run a small eval against the snapshot:

```bash
python -m arafatai eval-browser-snapshot \
  --snapshot "runs/add-listing-snapshot.json" \
  --must-contain "Here" \
  --min-clickables 1
```

## Lesson Memory Example

```bash
python -m arafatai remember \
  --lesson "The add-listing modal needs the real theme modal markup in rendered HTML." \
  --source "local add-listing debug" \
  --tag browser \
  --tag wordpress
```

## Tiny GPT Learning Module

Tiny GPT is for learning how LLM training works by hand. It is not meant to be
the production brain for ArafatAI.

Install the optional PyTorch dependency when you are ready for this part:

```bash
python -m pip install -e .[llm]
```

Train on a small text file:

```bash
python -m arafatai.learning.tiny_gpt.train \
  --input examples/tiny-gpt/sample.txt \
  --out-dir runs/tiny-gpt \
  --max-steps 200 \
  --device cpu
```

Generate text:

```bash
python -m arafatai.learning.tiny_gpt.generate \
  --checkpoint-dir runs/tiny-gpt \
  --prompt "ArafatAI"
```
