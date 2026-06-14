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
Phase 3: simple LLM brain with JSON actions
Phase 4: memory and evals
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
