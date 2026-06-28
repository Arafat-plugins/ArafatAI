# Roadmap

## Phase 1: Foundation

- Create repo structure.
- Add Python package skeleton.
- Add docs for architecture and safety.
- Add basic import tests.

## Phase 2: Browser Tool Adapter

- Connect the existing browser-agent MVP as a tool. Done in first adapter slice.
- Add Python wrapper around browser actions. Done in first adapter slice.
- Add snapshot format: URL, title, visible text, clickables, screenshots.
- Add richer DOM snapshot extraction.
- Add Python Playwright/CDP option if Node adapter becomes limiting.

## Phase 3: Browser Snapshot, Memory, And Evals

- Capture snapshot JSON: URL, title, visible text, clickables, forms, dialogs, notices.
- Add scorecards for browser snapshots.
- Add append-only lesson memory so failures become reusable knowledge.

## Phase 4: Simple AI Brain And Tiny GPT Learning

- Add LLM client.
- Force JSON action output.
- Validate action schema before execution.
- Run goal -> snapshot -> action -> tool -> result loop.
- Build Tiny GPT from scratch as a learning module.
- Keep Tiny GPT educational; use stronger provider models for practical agents until local models are proven.

## Phase 5: Memory And RAG

- Save run logs and lessons.
- Retrieve relevant notes before planning.
- Add workflow memory.

## Phase 6: Multi-Agent

- Planner routes work.
- Browser agent handles web actions.
- Coding agent handles repo changes.
- QA agent checks outputs.
- Memory agent stores lessons.

## Phase 7: PR-Gated Self Improvement

- AI creates branch.
- AI proposes scoped code changes.
- AI runs tests.
- AI writes PR summary.
- Human reviews and merges.

First implementation slice:

- `python -m arafatai propose-self-improvement` creates a proposal artifact.
- The artifact includes an eval case, test checklist, branch name, PR summary,
  and hard `auto_merge_allowed: false` gate.
- Code changes still happen only after the proposal is reviewed.
