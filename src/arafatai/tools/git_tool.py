"""Git tool placeholder."""

from __future__ import annotations

from arafatai.tools.tool_result import ToolResult


class GitTool:
    """Handles branch, diff, commit, and PR preparation."""

    def status(self) -> ToolResult:
        return ToolResult(ok=False, message="Git tool is not implemented yet.")
