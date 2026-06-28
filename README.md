# FLUID

Personal AI operating system for Arafat.

Goal:

```text
current Chrome sidebar testing
Node local bridge
Codex CLI temporary provider
no Python runtime required for sidebar testing

later FLUID core
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

## Sidebar Test Commands

```powershell
node tools\sidebar-bridge-node\src\server.mjs --port 8792 --token arafatai-local-token --cwd . --provider codex --timeout 45
```

Python-core planning can be tested through the same Chrome sidebar HTTP
contract while the Node bridge remains the lightweight browser adapter:

```powershell
node tools\sidebar-bridge-node\src\server.mjs --port 8792 --token arafatai-local-token --cwd . --provider python-core --python-path D:\ArafatTools\venvs\ArafatAI\Scripts\python.exe --timeout 45 --allow-local-fallback
```

## Later Python Core Commands

```bash
python -m pip install -e .
python -m arafatai --help
python -m arafatai sidebar-reason < request.json
python -m pytest
```

## PR-Gated Self Improvement

When FLUID fails or repeats a bad route, create a reviewable improvement
proposal before changing planner/tool code:

```powershell
python -m arafatai propose-self-improvement `
  --failure "Geo search returned no results after location detection." `
  --actual "FLUID guessed a fix without request evidence." `
  --expected "FLUID must inspect submitted coordinates before suggesting a patch." `
  --area directorist `
  --evidence "runs/bridge-tasks/<task-id>/evidence/search-form.json"
```

The command writes a proposal folder under `runs/self-improvement/` with an eval
case, PR summary, and runbook. It may append a lesson to `memory/lessons.jsonl`.
It does not patch code, push, merge, or deploy. Human review and a PR merge stay
mandatory.

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

The Chrome sidebar extension talks to a local FLUID bridge at
`http://127.0.0.1:8792`. The default bridge for sidebar testing is now a
dependency-free Node.js service that calls Codex CLI as the temporary testing
provider. The extension does not require Python packages for normal
browser-agent tests.

```powershell
node tools\sidebar-bridge-node\src\server.mjs --port 8792 --token arafatai-local-token --cwd . --provider codex --timeout 45
```

Or double-click:

```text
tools\sidebar-bridge-node\start-bridge.cmd
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
    { "type": "navigate", "target": "https://n8n.io", "reason": "start setup flow" },
    { "type": "click", "target": "text=Sign in", "reason": "continue setup flow" }
  ],
  "done": false,
  "needs_approval": true
}
```

The provider is replaceable. Later, FLUID's own model can return the same JSON
shape and the sidebar will keep working.

The sidebar now runs a small dynamic action-observation loop. The AI can choose
safe browser actions, the extension runs them, then the updated page observation
goes back to the AI for the next step.

The sidebar also shows real progress trace messages inside the chat:

```text
Task checkpoint created
Reading current tab snapshot
Planner requested
Reasoning summary
Running action
Action completed or blocked
```

These lines are emitted by the actual task/action code path. They are public
progress summaries, not hidden chain-of-thought.

The page snapshot includes an accessibility-style tree with stable `ref_*`
targets. The AI should prefer those refs for browser actions because they are
more reliable than guessing CSS selectors.

Tasks are checkpointed by the local bridge under:

```text
runs/bridge-tasks/
```

Bridge task API:

```text
POST /tasks              -> create a long-running browser task
GET  /tasks/{id}         -> read checkpoint and events
POST /tasks/{id}/plan    -> ask AI for the next step using saved observations
POST /tasks/{id}/plan-async -> start background AI planning and return immediately
POST /tasks/{id}/event   -> save page observations/action results
```

The sidebar uses `plan-async` and polls the task checkpoint. This avoids killing
the UI when the temporary Codex provider takes longer than a normal HTTP
request.

```text
navigate -> open a URL in the current tab
search   -> open Google web/image search
click    -> click a visible selector or text target
type     -> type into a visible field
press    -> press a key, usually Enter after typing into search fields
wait     -> wait for page changes
observe  -> re-read the page
```

Chrome internal pages such as `chrome://newtab` cannot be inspected like a
normal website DOM. For those pages, FLUID uses tab navigation instead of DOM
clicking. If the task needs credentials, payment, CAPTCHA, destructive changes,
publishing, or irreversible admin settings, the AI should ask before continuing.

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
the production brain for FLUID.

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
  --prompt "FLUID"
```
