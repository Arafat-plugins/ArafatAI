# Roadmap

## Phase 1: Foundation

- Create repo structure.
- Add Python package skeleton.
- Add docs for architecture and safety.
- Add basic import tests.

## Phase 2: Browser Tool Adapter

- Connect the existing browser-agent MVP as a tool.
- Add Python wrapper around browser actions.
- Add snapshot format: URL, title, visible text, clickables, screenshots.

## Phase 3: Simple AI Brain

- Add LLM client.
- Force JSON action output.
- Validate action schema before execution.
- Run goal -> snapshot -> action -> tool -> result loop.

## Phase 4: Memory

- Save run logs and lessons.
- Retrieve relevant notes before planning.
- Add workflow memory.

## Phase 5: Multi-Agent

- Planner routes work.
- Browser agent handles web actions.
- Coding agent handles repo changes.
- QA agent checks outputs.
- Memory agent stores lessons.

## Phase 6: PR-Gated Self Improvement

- AI creates branch.
- AI proposes scoped code changes.
- AI runs tests.
- AI writes PR summary.
- Human reviews and merges.
