"""Browser tool adapter placeholder."""

from __future__ import annotations

from arafatai.tools.tool_result import ToolResult


class BrowserTool:
    """Adapter for browser automation tools.

    First implementation target: wrap the existing Node browser-agent MVP.
    Later target: Python Playwright/CDP implementation.
    """

    def snapshot(self, url: str) -> ToolResult:
        return ToolResult(
            ok=False,
            message="Browser snapshot is not implemented yet.",
            data={"url": url},
        )
