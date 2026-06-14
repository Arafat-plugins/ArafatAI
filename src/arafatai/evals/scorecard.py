"""Small eval scorecards for agent outputs."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path


@dataclass(frozen=True)
class ScorecardResult:
    passed: bool
    score: float
    checks: list[dict[str, object]]

    def to_dict(self) -> dict[str, object]:
        return {"passed": self.passed, "score": self.score, "checks": self.checks}


def _snapshot_text(snapshot: dict[str, object]) -> str:
    parts = [
        str(snapshot.get("url", "")),
        str(snapshot.get("title", "")),
        str(snapshot.get("visible_text", "")),
    ]
    for item in snapshot.get("clickables", []) or []:
        if isinstance(item, dict):
            parts.append(str(item.get("text", "")))
            parts.append(str(item.get("selector", "")))
    return "\n".join(parts).lower()


def evaluate_browser_snapshot(
    snapshot: dict[str, object],
    *,
    must_contain: list[str] | tuple[str, ...] = (),
    min_clickables: int = 0,
) -> ScorecardResult:
    checks: list[dict[str, object]] = []
    haystack = _snapshot_text(snapshot)

    for needle in must_contain:
        ok = needle.lower() in haystack
        checks.append({"name": f"contains:{needle}", "passed": ok})

    clickables = snapshot.get("clickables", []) or []
    checks.append(
        {
            "name": f"min_clickables:{min_clickables}",
            "passed": isinstance(clickables, list) and len(clickables) >= min_clickables,
            "actual": len(clickables) if isinstance(clickables, list) else 0,
        }
    )

    passed_count = sum(1 for check in checks if check["passed"])
    score = passed_count / len(checks) if checks else 1.0
    return ScorecardResult(passed=passed_count == len(checks), score=score, checks=checks)


def load_snapshot(path: str | Path) -> dict[str, object]:
    return json.loads(Path(path).read_text(encoding="utf-8"))

