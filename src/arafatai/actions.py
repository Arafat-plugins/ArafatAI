"""Validated action schema for agent tool calls."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, ClassVar, Literal

ActionType = Literal["click", "type", "upload", "wait", "expect", "screenshot", "stop"]


RISKY_WORDS = (
    "save",
    "delete",
    "remove",
    "publish",
    "post",
    "submit",
    "confirm",
    "continue",
    "checkout",
    "pay",
    "payment",
    "merge",
    "deploy",
    "approve",
)


@dataclass(frozen=True)
class BrowserAction:
    """One browser action requested by an agent.

    The schema is intentionally small so an LLM can return predictable JSON and
    the runtime can reject unsafe or malformed actions before execution.
    """

    type: ActionType
    target: str | None = None
    value: str | int | None = None
    reason: str | None = None

    allowed_types: ClassVar[set[str]] = {
        "click",
        "type",
        "upload",
        "wait",
        "expect",
        "screenshot",
        "stop",
    }

    @classmethod
    def from_json(cls, raw: str) -> "BrowserAction":
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Action must be valid JSON: {exc.msg}") from exc

        if not isinstance(data, dict):
            raise ValueError("Action JSON must be an object.")

        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BrowserAction":
        action_type = data.get("type") or data.get("action")
        if action_type not in cls.allowed_types:
            allowed = ", ".join(sorted(cls.allowed_types))
            raise ValueError(f"Unsupported action type {action_type!r}. Allowed: {allowed}.")

        target = data.get("target") or data.get("selector")
        value = data.get("value") if "value" in data else data.get("text")
        reason = data.get("reason")

        action = cls(type=action_type, target=target, value=value, reason=reason)  # type: ignore[arg-type]
        action.validate()
        return action

    def validate(self) -> None:
        if self.type in {"click", "expect"} and not self.target:
            raise ValueError(f"{self.type} action requires target.")

        if self.type in {"type", "upload"}:
            if not self.target:
                raise ValueError(f"{self.type} action requires target.")
            if self.value in (None, ""):
                raise ValueError(f"{self.type} action requires value.")

        if self.type in {"wait", "screenshot"} and self.value in (None, ""):
            raise ValueError(f"{self.type} action requires value.")

        if self.type == "wait":
            try:
                wait_ms = int(self.value)  # type: ignore[arg-type]
            except (TypeError, ValueError) as exc:
                raise ValueError("wait action value must be milliseconds.") from exc
            if wait_ms < 0:
                raise ValueError("wait action value cannot be negative.")

    @property
    def risky(self) -> bool:
        text = " ".join(
            str(part).lower()
            for part in (self.type, self.target, self.value, self.reason)
            if part is not None
        )
        return any(word in text for word in RISKY_WORDS)

    def to_node_cli_args(self) -> list[str]:
        """Convert this action to the existing Node browser-agent CLI args."""

        if self.type == "click":
            return ["--click", self.target or ""]

        if self.type == "type":
            return ["--type", f"{self.target}={self.value}"]

        if self.type == "upload":
            return ["--upload", f"{self.target}={self.value}"]

        if self.type == "wait":
            return ["--wait", str(self.value)]

        if self.type == "expect":
            return ["--expect", self.target or ""]

        if self.type == "screenshot":
            return ["--screenshot", str(self.value)]

        if self.type == "stop":
            return []

        raise ValueError(f"Unsupported action type: {self.type}")
