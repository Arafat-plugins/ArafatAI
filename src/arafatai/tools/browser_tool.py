"""Browser tool adapter."""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from arafatai.actions import BrowserAction
from arafatai.tools.tool_result import ToolResult


DEFAULT_NODE_BROWSER_TOOL = (
    Path("C:/Users/Arafat/Local Sites/user-sites/app/public/tools/browser-agent-mvp")
)


@dataclass(frozen=True)
class BrowserToolConfig:
    node_tool_path: Path = DEFAULT_NODE_BROWSER_TOOL
    node_bin: str = "node"
    timeout_seconds: int = 90


class BrowserTool:
    """Adapter for browser automation tools.

    This first implementation wraps the existing Node browser-agent MVP. The
    ArafatAI core stays Python-first while the browser hand can remain a
    replaceable adapter.
    """

    def __init__(self, config: BrowserToolConfig | None = None) -> None:
        env_path = os.getenv("ARAFATAI_BROWSER_AGENT_NODE")
        if config is None and env_path:
            config = BrowserToolConfig(node_tool_path=Path(env_path))
        self.config = config or BrowserToolConfig()

    def run_actions(
        self,
        url: str,
        actions: list[BrowserAction],
        *,
        allow_risky: bool = False,
        headless: bool = True,
        user_data_dir: str | None = None,
        keep_open: bool = False,
    ) -> ToolResult:
        if not url:
            return ToolResult(ok=False, message="URL is required.")

        if not actions:
            return ToolResult(ok=False, message="At least one browser action is required.")

        risky_actions = [action for action in actions if action.risky]
        if risky_actions and not allow_risky:
            return ToolResult(
                ok=False,
                message="Risky browser action blocked. Re-run with explicit approval.",
                data={"risky_actions": [action.__dict__ for action in risky_actions]},
            )

        tool_path = self.config.node_tool_path
        cli_path = tool_path / "src" / "cli.js"
        if not cli_path.exists():
            return ToolResult(
                ok=False,
                message="Node browser-agent MVP was not found.",
                data={"expected_cli": str(cli_path)},
            )

        command = [self.config.node_bin, str(cli_path), "--url", url]
        for action in actions:
            command.extend(action.to_node_cli_args())

        if allow_risky:
            command.append("--yes")
        if headless:
            command.append("--headless")
        if user_data_dir:
            command.extend(["--user-data-dir", user_data_dir])
        if keep_open:
            command.append("--keep-open")

        try:
            completed = subprocess.run(
                command,
                cwd=tool_path,
                text=True,
                capture_output=True,
                timeout=self.config.timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            return ToolResult(
                ok=False,
                message="Browser action timed out.",
                data={"command": command, "timeout_seconds": self.config.timeout_seconds, "error": str(exc)},
            )

        return ToolResult(
            ok=completed.returncode == 0,
            message="Browser action completed." if completed.returncode == 0 else "Browser action failed.",
            data={
                "command": command,
                "returncode": completed.returncode,
                "stdout": completed.stdout,
                "stderr": completed.stderr,
            },
        )

    def snapshot(self, url: str) -> ToolResult:
        action = BrowserAction(type="screenshot", value="runs/snapshot.png")
        return self.run_actions(url, [action], allow_risky=True)
