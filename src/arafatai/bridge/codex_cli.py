"""Safe local Codex CLI bridge.

The bridge follows the same idea as the StorePilot AI helpdesk bridge: a local
HTTP process receives a small JSON payload, builds a strict prompt, and asks
Codex CLI for a response in read-only, ephemeral mode.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import glob
import json
import os
import shutil
import subprocess
import tempfile


DEFAULT_TOKEN = "arafatai-local-token"


@dataclass(frozen=True)
class CodexCLIConfig:
    codex_path: str | None = None
    cwd: Path = Path.cwd()
    timeout_seconds: int = 45
    sandbox: str = "read-only"


@dataclass(frozen=True)
class CodexCLIResponse:
    ok: bool
    text: str
    source: str
    error: str | None = None


def find_codex_command(configured: str | None = None) -> str | None:
    """Find Codex CLI without requiring the caller to know the install path."""

    candidates = [
        configured,
        os.getenv("ARAFATAI_CODEX_CLI_PATH"),
        os.getenv("CODEX_CLI_PATH"),
        shutil.which("codex"),
    ]

    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate))

    home = os.getenv("USERPROFILE") or os.getenv("HOME")
    if not home:
        return None

    patterns = [
        str(Path(home) / ".vscode" / "extensions" / "openai.chatgpt-*" / "bin" / "windows-x86_64" / "codex.exe"),
    ]
    matches: list[str] = []
    for pattern in patterns:
        matches.extend(glob.glob(pattern))
    matches.sort(reverse=True)

    for match in matches:
        if Path(match).is_file():
            return match

    return None


def build_extension_prompt(body: dict[str, object]) -> str:
    """Build a bounded prompt for extension/sidebar requests."""

    mode = str(body.get("mode") or "chat")
    goal = str(body.get("goal") or body.get("message") or "")
    page = body.get("page") if isinstance(body.get("page"), dict) else {}
    history = body.get("history") if isinstance(body.get("history"), list) else []

    instructions = [
        "You are ArafatAI running behind a local browser sidebar extension.",
        "Return only the final user-facing answer. Do not reveal hidden chain-of-thought.",
        "Do not edit files, run shell commands, use browser tools, or claim that an action was completed.",
        "Use only the supplied page snapshot and request context.",
        "If the user asks for a browser action, describe the safe next step and whether human approval is needed.",
        "Keep the reply concise and in the same language style as the user.",
    ]

    if mode == "browser_plan":
        instructions.extend(
            [
                "Return strict JSON only.",
                "Schema: {\"reply\":\"short explanation\",\"actions\":[{\"type\":\"click|type|expect|screenshot\",\"target\":\"selector or text=Label\",\"value\":\"optional\",\"reason\":\"why\"}],\"needs_approval\":true|false}",
                "Use selectors or visible text from the supplied page snapshot. Do not invent completed actions.",
            ]
        )

    context = {
        "mode": mode,
        "goal": goal,
        "page": page,
        "history": history[-6:],
    }

    return "\n".join(
        [
            *instructions,
            "",
            "Request JSON:",
            json.dumps(context, indent=2, ensure_ascii=False, sort_keys=True),
        ]
    )


class CodexCLIBridge:
    def __init__(self, config: CodexCLIConfig | None = None) -> None:
        self.config = config or CodexCLIConfig()

    def reason(self, body: dict[str, object]) -> CodexCLIResponse:
        codex = find_codex_command(self.config.codex_path)
        if not codex:
            return CodexCLIResponse(
                ok=False,
                text="Codex CLI was not found. Set ARAFATAI_CODEX_CLI_PATH or install Codex CLI.",
                source="local-fallback",
                error="codex_not_found",
            )

        prompt = build_extension_prompt(body)
        cwd = self.config.cwd
        cwd.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory(prefix="arafatai-codex-") as tmp:
            out_file = Path(tmp) / "last-message.txt"
            command = [
                codex,
                "-a",
                "never",
                "exec",
                "-C",
                str(cwd),
                "--sandbox",
                self.config.sandbox,
                "--skip-git-repo-check",
                "--ephemeral",
                "--color",
                "never",
                "--output-last-message",
                str(out_file),
                "-",
            ]

            try:
                completed = subprocess.run(
                    command,
                    input=prompt,
                    text=True,
                    capture_output=True,
                    timeout=self.config.timeout_seconds,
                    check=False,
                    cwd=cwd,
                )
            except subprocess.TimeoutExpired:
                return CodexCLIResponse(
                    ok=False,
                    text="Codex CLI timed out.",
                    source="local-fallback",
                    error="timeout",
                )

            text = out_file.read_text(encoding="utf-8").strip() if out_file.exists() else ""
            if not text:
                text = completed.stdout.strip()

            if completed.returncode != 0 and not text:
                return CodexCLIResponse(
                    ok=False,
                    text="Codex CLI failed.",
                    source="local-fallback",
                    error=(completed.stderr or "codex_failed").strip()[:500],
                )

            if not text:
                return CodexCLIResponse(
                    ok=False,
                    text="Codex CLI returned an empty response.",
                    source="local-fallback",
                    error="empty_response",
                )

            return CodexCLIResponse(ok=True, text=text, source="codex-cli")

