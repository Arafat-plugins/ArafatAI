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

from arafatai.bridge.local_planner import build_local_agent_reply


DEFAULT_TOKEN = "arafatai-local-token"


@dataclass(frozen=True)
class CodexCLIConfig:
    codex_path: str | None = None
    cwd: Path = Path.cwd()
    timeout_seconds: int = 300
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


def _shorten(value: object, limit: int) -> str:
    text = str(value or "")
    return text if len(text) <= limit else text[:limit] + f"\n[truncated {len(text) - limit} chars]"


def _compact_clickable(item: object) -> dict[str, object] | None:
    if not isinstance(item, dict):
        return None
    return {
        "ref": item.get("ref") or "",
        "text": _shorten(item.get("text"), 140),
        "selector": _shorten(item.get("selector"), 180),
        "role": item.get("role") or "",
        "type": item.get("type") or "",
        "href": _shorten(item.get("href"), 220),
    }


def _compact_form(form: object) -> dict[str, object] | None:
    if not isinstance(form, dict):
        return None
    fields = form.get("fields") if isinstance(form.get("fields"), list) else []
    return {
        "selector": _shorten(form.get("selector"), 180),
        "action": _shorten(form.get("action"), 220),
        "method": form.get("method") or "",
        "fields": [
            {
                "ref": field.get("ref") or "",
                "selector": _shorten(field.get("selector"), 180),
                "name": field.get("name") or "",
                "type": field.get("type") or "",
                "placeholder": _shorten(field.get("placeholder"), 120),
            }
            for field in fields[:20]
            if isinstance(field, dict)
        ],
    }


def compact_page(page: dict[str, object]) -> dict[str, object]:
    clickables = page.get("clickables") if isinstance(page.get("clickables"), list) else []
    forms = page.get("forms") if isinstance(page.get("forms"), list) else []
    dialogs = page.get("dialogs") if isinstance(page.get("dialogs"), list) else []

    return {
        "url": page.get("url") or "",
        "title": page.get("title") or "",
        "viewport": page.get("viewport") if isinstance(page.get("viewport"), dict) else {},
        "accessibility_tree": _shorten(page.get("accessibility_tree"), 6000),
        "visible_text": _shorten(page.get("visible_text"), 1200),
        "clickables": [item for item in (_compact_clickable(item) for item in clickables[:80]) if item],
        "forms": [item for item in (_compact_form(form) for form in forms[:10]) if item],
        "dialogs": [
            {
                "selector": _shorten(dialog.get("selector"), 180),
                "text": _shorten(dialog.get("text"), 400),
            }
            for dialog in dialogs[:8]
            if isinstance(dialog, dict)
        ],
    }


def compact_task_state(task_state: dict[str, object]) -> dict[str, object]:
    observations = task_state.get("observations") if isinstance(task_state.get("observations"), list) else []
    compact_observations = []
    for observation in observations[-8:]:
        if not isinstance(observation, dict):
            continue
        compact_observations.append(
            {
                "kind": observation.get("kind") or "",
                "status": observation.get("status") or "",
                "message": _shorten(observation.get("message"), 300),
                "result": observation.get("result") if isinstance(observation.get("result"), dict) else {},
            }
        )

    return {
        "task_id": task_state.get("task_id") or "",
        "step": task_state.get("step") or "",
        "max_steps": task_state.get("max_steps") or "",
        "observations": compact_observations,
    }


def build_extension_prompt(body: dict[str, object]) -> str:
    """Build a bounded prompt for extension/sidebar requests."""

    mode = str(body.get("mode") or "chat")
    goal = str(body.get("goal") or body.get("message") or "")
    raw_page = body.get("page") if isinstance(body.get("page"), dict) else {}
    page = compact_page(raw_page)
    history = body.get("history") if isinstance(body.get("history"), list) else []
    raw_task_state = body.get("task_state") if isinstance(body.get("task_state"), dict) else {}
    task_state = compact_task_state(raw_task_state)
    approval_policy = str(body.get("approval_policy") or "ask")

    instructions = [
        "You are ArafatAI running behind a local browser sidebar extension.",
        "This is a temporary Codex-backed provider. The final system will be driven by Arafat's own AI through the same JSON contract.",
        "Do not reveal hidden chain-of-thought. Use only a concise observable reasoning_summary.",
        "Do not edit files, run shell commands, use browser tools, or claim that an action was completed.",
        "Use only the supplied page snapshot and request context.",
        "If the page snapshot is insufficient or the target is ambiguous, ask a short question instead of inventing an action.",
        "Any browser action must be proposed only; the extension executes actions after human approval.",
        "Keep the reply concise and in the same language style as the user.",
    ]

    if mode in {"browser_plan", "agent_chat", "agent_plan", "agent_task"}:
        instructions.extend(
            [
                "Return strict JSON only.",
                "Schema: {\"reply\":\"short user-facing answer\",\"reasoning_summary\":[\"1-4 short evidence-based bullets\"],\"questions\":[\"short question if needed\"],\"actions\":[{\"type\":\"navigate|search|click|type|press|wait|observe\",\"target\":\"ref id, selector, URL, or search query\",\"value\":\"optional query/text/URL/key/wait ms\",\"mode\":\"web|images\",\"reason\":\"why this action is safe and relevant\"}],\"done\":true|false,\"needs_approval\":true}",
                "Use ref ids from page.accessibility_tree when available, for example target: \"ref_12\".",
                "Use selectors or visible text from the supplied page snapshot only when no ref id exists. Do not invent completed actions.",
                "For click actions, never use generic selectors like \"a\", \"button\", \"input\", or \"[role=button]\". Use a ref id or target like \"text=Exact visible label\".",
                "If the only identifier is visible link/button text, set target to \"text=...\" and put the human explanation in reason.",
                "For agent_task, act like a browser agent: choose the next 1-3 safe actions, then wait for observations in task_state.",
                "Use previous task_state observations to decide whether the task is done or what to do next.",
                "Set done true only when observations or page snapshot show the requested task is complete.",
                "If credentials, payment, CAPTCHA, destructive changes, publishing, or irreversible admin changes are needed, ask a question and return no actions.",
                "For agent_chat, actions may be empty if explanation or questions are enough.",
                "If approval_policy is chat-safe-actions and the user clearly asks to search or open a URL, return one search or navigate action.",
                "If approval_policy is auto-safe-actions, you may return safe navigate, search, click, type, wait, or observe actions.",
                "For Chrome internal pages such as chrome://newtab, do not ask for a DOM snapshot; use search or navigate when the user asks for it.",
                "For agent_plan, prefer one next action only.",
                "If approval_policy is chat-only, keep actions empty and answer conversationally.",
                "If approval_policy is plan-only, still return proposed actions but needs_approval must be true.",
            ]
        )

    context = {
        "mode": mode,
        "goal": goal,
        "page": page,
        "history": history[-6:],
        "task_state": task_state,
        "approval_policy": approval_policy,
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
        local_reply = build_local_agent_reply(body, allow_question_fallback=False)
        if local_reply:
            return CodexCLIResponse(ok=True, text=local_reply, source="local-planner")

        codex = find_codex_command(self.config.codex_path)
        if not codex:
            fallback = build_local_agent_reply(body)
            if fallback:
                return CodexCLIResponse(ok=True, text=fallback, source="local-planner")
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
                fallback = build_local_agent_reply(body)
                if fallback:
                    return CodexCLIResponse(ok=True, text=fallback, source="local-planner-timeout-fallback")
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
                fallback = build_local_agent_reply(body)
                if fallback:
                    return CodexCLIResponse(ok=True, text=fallback, source="local-planner-error-fallback")
                return CodexCLIResponse(
                    ok=False,
                    text="Codex CLI failed.",
                    source="local-fallback",
                    error=(completed.stderr or "codex_failed").strip()[:500],
                )

            if not text:
                fallback = build_local_agent_reply(body)
                if fallback:
                    return CodexCLIResponse(ok=True, text=fallback, source="local-planner-empty-fallback")
                return CodexCLIResponse(
                    ok=False,
                    text="Codex CLI returned an empty response.",
                    source="local-fallback",
                    error="empty_response",
                )

            return CodexCLIResponse(ok=True, text=text, source="codex-cli")
