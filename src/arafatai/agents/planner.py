"""Planner agent scaffold."""

from __future__ import annotations


class PlannerAgent:
    """Break a user goal into next steps.

    This is intentionally simple for the first commit. The LLM-backed planner
    will replace this placeholder once the action schema is implemented.
    """

    def plan(self, goal: str) -> str:
        return (
            "Planner scaffold\n"
            f"Goal: {goal}\n"
            "Next: add JSON action schema, tool validation, and agent loop."
        )
