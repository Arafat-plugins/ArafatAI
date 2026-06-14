"""Shell tool placeholder with safety-first defaults."""

from __future__ import annotations

from arafatai.tools.tool_result import ToolResult


class ShellTool:
    """Runs approved shell commands.

    Destructive commands and broad filesystem writes will require an approval
    layer before this tool is enabled.
    """

    def run(self, command: str) -> ToolResult:
        return ToolResult(
            ok=False,
            message="Shell execution is not enabled yet.",
            data={"command": command},
        )
