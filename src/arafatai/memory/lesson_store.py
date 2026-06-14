"""Append-only lesson memory for ArafatAI."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path


@dataclass(frozen=True)
class Lesson:
    lesson: str
    source: str
    evidence: str | None = None
    tags: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def validate(self) -> None:
        if not self.lesson.strip():
            raise ValueError("lesson cannot be empty.")
        if not self.source.strip():
            raise ValueError("source cannot be empty.")


class LessonStore:
    def __init__(self, path: str | Path = "memory/lessons.jsonl") -> None:
        self.path = Path(path)

    def append(self, lesson: Lesson) -> dict[str, str | list[str] | None]:
        lesson.validate()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        row = asdict(lesson)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        return row

    def search(self, query: str, *, limit: int = 10) -> list[dict[str, object]]:
        if not self.path.exists():
            return []
        needle = query.lower()
        results = []
        with self.path.open("r", encoding="utf-8") as handle:
            for line in handle:
                row = json.loads(line)
                haystack = " ".join(str(row.get(key, "")) for key in ("lesson", "source", "evidence", "tags")).lower()
                if needle in haystack:
                    results.append(row)
        return results[-limit:]

