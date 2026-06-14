# Architecture

## Principle

ArafatAI is Python-first.

```text
Python = brain, agents, memory, evals, orchestration
Tools = controlled hands, including optional Node adapters
Git PR = safe self-improvement gate
Human = final approval
```

The first browser tool is a Python wrapper around the existing Node
browser-agent MVP. This keeps the AI core Python-first while reusing the
already-working Chrome DevTools browser hand.

## Core Loop

```text
1. User gives goal.
2. Planner agent breaks goal into steps.
3. Agent requests tool action.
4. Tool validates and executes.
5. Result is logged.
6. QA/eval checks result.
7. Memory agent saves lesson.
8. If code improvement is needed, Coding Agent prepares a branch/PR.
```

## Agent Types

```text
Planner Agent: breaks goals into tasks.
Browser Agent: navigates pages and collects screenshots/DOM evidence.
Coding Agent: edits code and prepares PR summaries.
QA Agent: verifies outputs, tests, and risks.
Memory Agent: saves and retrieves lessons.
Research Agent: reads docs and summarizes current facts.
```

## Safety Gates

Risky actions must ask for human approval:

```text
save
delete
publish
post
submit
payment
merge
deploy
permission approval
```

The system must not auto-merge PRs.

## Browser Action Schema

Browser actions use small validated JSON:

```json
{
  "type": "click",
  "target": "text=Here",
  "reason": "Open the login modal"
}
```

Allowed action types:

```text
click
type
upload
wait
expect
screenshot
stop
```

The wrapper rejects malformed actions before calling the browser tool.
