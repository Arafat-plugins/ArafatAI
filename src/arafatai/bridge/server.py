"""HTTP bridge for ArafatAI browser extension testing."""

from __future__ import annotations

from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Lock, Thread
from typing import Any
from urllib.parse import urlparse

from arafatai.bridge.codex_cli import CodexCLIBridge, CodexCLIConfig, DEFAULT_TOKEN
from arafatai.bridge.task_store import TaskStore


@dataclass(frozen=True)
class BridgeServerConfig:
    host: str = "127.0.0.1"
    port: int = 8792
    token: str = DEFAULT_TOKEN
    codex_path: str | None = None
    cwd: Path = Path.cwd()
    timeout_seconds: int = 300


def make_handler(config: BridgeServerConfig):
    bridge = CodexCLIBridge(
        CodexCLIConfig(
            codex_path=config.codex_path,
            cwd=config.cwd,
            timeout_seconds=config.timeout_seconds,
        )
    )
    tasks = TaskStore(config.cwd / "runs" / "bridge-tasks")
    planning_tasks: set[str] = set()
    planning_lock = Lock()

    def build_plan_request(task_id: str, body: dict[str, object]) -> dict[str, object] | None:
        task = tasks.get(task_id)
        if task is None:
            return None

        step_state = body.get("task_state") if isinstance(body.get("task_state"), dict) else {}
        step_state = {
            **step_state,
            "task_id": task_id,
            "observations": tasks.observations(task_id),
        }
        return {
            "mode": "agent_task",
            "goal": task.get("goal", ""),
            "page": body.get("page") if isinstance(body.get("page"), dict) else {},
            "history": task.get("history") if isinstance(task.get("history"), list) else [],
            "task_state": step_state,
            "approval_policy": body.get("approval_policy") or "auto-safe-actions",
        }

    def run_plan_job(task_id: str, body: dict[str, object]) -> None:
        try:
            request = build_plan_request(task_id, body)
            if request is None:
                return

            task_state = request.get("task_state") if isinstance(request.get("task_state"), dict) else {}
            result = bridge.reason(request)
            tasks.append_event(
                task_id,
                {
                    "kind": "plan",
                    "status": "running" if result.ok else "blocked",
                    "step": task_state.get("step"),
                    "ok": result.ok,
                    "text": result.text,
                    "source": result.source,
                    "error": result.error,
                },
            )
        finally:
            with planning_lock:
                planning_tasks.discard(task_id)

    class ArafatAIBridgeHandler(BaseHTTPRequestHandler):
        server_version = "ArafatAIBridge/0.1"

        def do_OPTIONS(self) -> None:
            self._send_json(200, {"ok": True})

        def do_GET(self) -> None:
            path = urlparse(self.path).path
            if path in {"/", "/health"}:
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "service": "ArafatAI local Codex bridge",
                        "routes": [
                            "/health",
                            "/reason",
                            "/tasks",
                            "/tasks/{id}",
                            "/tasks/{id}/plan",
                            "/tasks/{id}/plan-async",
                            "/tasks/{id}/event",
                        ],
                    },
                )
                return

            task_id = self._task_id_from_path(path)
            if task_id:
                if not self._authorized():
                    self._send_json(403, {"ok": False, "error": "invalid_token"})
                    return

                task = tasks.get(task_id)
                if task is None:
                    self._send_json(404, {"ok": False, "error": "task_not_found"})
                    return

                self._send_json(200, {"ok": True, "task": task})
                return

            self._send_json(404, {"ok": False, "error": "not_found"})

        def do_POST(self) -> None:
            path = urlparse(self.path).path

            if not self._authorized():
                self._send_json(403, {"ok": False, "error": "invalid_token"})
                return

            body = self._read_body()
            if body is None:
                self._send_json(400, {"ok": False, "error": "invalid_json"})
                return

            if path == "/tasks":
                goal = str(body.get("goal") or "").strip()
                if not goal:
                    self._send_json(400, {"ok": False, "error": "missing_goal"})
                    return
                history = body.get("history") if isinstance(body.get("history"), list) else []
                task = tasks.create(goal, history)
                self._send_json(200, {"ok": True, "task": task})
                return

            task_id = self._task_id_from_path(path)
            if task_id and path.endswith("/event"):
                event = body.get("event") if isinstance(body.get("event"), dict) else body
                task = tasks.append_event(task_id, event)
                if task is None:
                    self._send_json(404, {"ok": False, "error": "task_not_found"})
                    return
                self._send_json(200, {"ok": True, "task": task})
                return

            if task_id and path.endswith("/plan"):
                request = build_plan_request(task_id, body)
                if request is None:
                    self._send_json(404, {"ok": False, "error": "task_not_found"})
                    return

                task_state = request.get("task_state") if isinstance(request.get("task_state"), dict) else {}
                result = bridge.reason(request)
                tasks.append_event(
                    task_id,
                    {
                        "kind": "plan",
                        "status": "running" if result.ok else "blocked",
                        "step": task_state.get("step"),
                        "ok": result.ok,
                        "text": result.text,
                        "source": result.source,
                        "error": result.error,
                    },
                )
                self._send_json(
                    200 if result.ok else 502,
                    {
                        "ok": result.ok,
                        "text": result.text,
                        "source": result.source,
                        "error": result.error,
                        "task_id": task_id,
                    },
                )
                return

            if task_id and path.endswith("/plan-async"):
                if tasks.get(task_id) is None:
                    self._send_json(404, {"ok": False, "error": "task_not_found"})
                    return

                task_state = body.get("task_state") if isinstance(body.get("task_state"), dict) else {}
                with planning_lock:
                    already_planning = task_id in planning_tasks
                    if not already_planning:
                        planning_tasks.add(task_id)

                if not already_planning:
                    tasks.append_event(
                        task_id,
                        {
                            "kind": "planning_started",
                            "status": "planning",
                            "step": task_state.get("step"),
                            "message": "AI planning started in the background.",
                        },
                    )
                    Thread(target=run_plan_job, args=(task_id, body), daemon=True).start()

                self._send_json(
                    202,
                    {
                        "ok": True,
                        "task_id": task_id,
                        "status": "planning",
                        "already_planning": already_planning,
                    },
                )
                return

            if path != "/reason":
                self._send_json(404, {"ok": False, "error": "not_found"})
                return

            result = bridge.reason(body)
            self._send_json(
                200 if result.ok else 502,
                {
                    "ok": result.ok,
                    "text": result.text,
                    "source": result.source,
                    "error": result.error,
                },
            )

        def log_message(self, format: str, *args: Any) -> None:
            # Keep the bridge quiet for extension testing.
            return

        def _authorized(self) -> bool:
            supplied = self.headers.get("x-arafatai-token", "")
            return bool(config.token) and supplied == config.token

        def _read_body(self) -> dict[str, object] | None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return None

            raw = self.rfile.read(length).decode("utf-8")
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                return None

            return parsed if isinstance(parsed, dict) else None

        def _task_id_from_path(self, path: str) -> str | None:
            parts = [part for part in path.split("/") if part]
            if len(parts) >= 2 and parts[0] == "tasks":
                return parts[1]
            return None

        def _send_json(self, status: int, payload: dict[str, object]) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, x-arafatai-token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
            self.wfile.write(data)

    return ArafatAIBridgeHandler


def run_server(config: BridgeServerConfig) -> None:
    handler = make_handler(config)
    server = ThreadingHTTPServer((config.host, config.port), handler)
    print(f"ArafatAI bridge listening on http://{config.host}:{config.port}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping ArafatAI bridge.")
    finally:
        server.server_close()
