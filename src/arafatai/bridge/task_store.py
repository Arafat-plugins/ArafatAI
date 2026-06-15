"""Persistent task checkpoints for the local browser agent bridge."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class TaskStore:
    root: Path
    _lock: RLock = field(default_factory=RLock, init=False, repr=False)

    def __post_init__(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    def create(self, goal: str, history: list[object] | None = None) -> dict[str, Any]:
        with self._lock:
            task_id = uuid4().hex
            now = utc_now()
            task: dict[str, Any] = {
                "id": task_id,
                "goal": goal,
                "status": "running",
                "created_at": now,
                "updated_at": now,
                "history": history or [],
                "events": [],
            }
            self._write(task)
            return task

    def get(self, task_id: str) -> dict[str, Any] | None:
        with self._lock:
            path = self._path(task_id)
            if not path.exists():
                return None
            try:
                task = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                return None
            return task if isinstance(task, dict) else None

    def append_event(self, task_id: str, event: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock:
            task = self.get(task_id)
            if task is None:
                return None

            events = task.setdefault("events", [])
            if not isinstance(events, list):
                events = []
                task["events"] = events

            event_id = len(events) + 1
            events.append(
                {
                    "event_id": event_id,
                    "at": utc_now(),
                    **event,
                }
            )
            task["updated_at"] = utc_now()
            status = event.get("status")
            if isinstance(status, str) and status:
                task["status"] = status
            self._write(task)
            return task

    def observations(self, task_id: str, limit: int = 8) -> list[dict[str, Any]]:
        with self._lock:
            task = self.get(task_id)
            if task is None:
                return []
            events = task.get("events", [])
            if not isinstance(events, list):
                return []
            observations = [event for event in events if isinstance(event, dict) and event.get("kind") == "observation"]
            return observations[-limit:]

    def _path(self, task_id: str) -> Path:
        safe_id = "".join(ch for ch in task_id if ch.isalnum() or ch in {"-", "_"})
        return self.root / f"{safe_id}.json"

    def _write(self, task: dict[str, Any]) -> None:
        path = self._path(str(task["id"]))
        tmp_path = path.with_suffix(".json.tmp")
        tmp_path.write_text(json.dumps(task, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        tmp_path.replace(path)
