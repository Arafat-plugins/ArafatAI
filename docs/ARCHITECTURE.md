# Architecture

## Principle

ArafatAI is Python-first.

```text
Python = brain, agents, memory, evals, orchestration
Tools = controlled hands
Git PR = safe self-improvement gate
Human = final approval
```

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
