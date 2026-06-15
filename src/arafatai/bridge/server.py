"""HTTP bridge for ArafatAI browser extension testing."""

from __future__ import annotations

from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from arafatai.bridge.codex_cli import CodexCLIBridge, CodexCLIConfig, DEFAULT_TOKEN


@dataclass(frozen=True)
class BridgeServerConfig:
    host: str = "127.0.0.1"
    port: int = 8792
    token: str = DEFAULT_TOKEN
    codex_path: str | None = None
    cwd: Path = Path.cwd()
    timeout_seconds: int = 45


def make_handler(config: BridgeServerConfig):
    bridge = CodexCLIBridge(
        CodexCLIConfig(
            codex_path=config.codex_path,
            cwd=config.cwd,
            timeout_seconds=config.timeout_seconds,
        )
    )

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
                        "routes": ["/health", "/reason"],
                    },
                )
                return

            self._send_json(404, {"ok": False, "error": "not_found"})

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            if path != "/reason":
                self._send_json(404, {"ok": False, "error": "not_found"})
                return

            if not self._authorized():
                self._send_json(403, {"ok": False, "error": "invalid_token"})
                return

            body = self._read_body()
            if body is None:
                self._send_json(400, {"ok": False, "error": "invalid_json"})
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

