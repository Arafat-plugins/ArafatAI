from pathlib import Path

from arafatai.bridge.codex_cli import CodexCLIConfig, build_extension_prompt
from arafatai.bridge.server import BridgeServerConfig, make_handler


def test_extension_prompt_includes_page_snapshot_and_safety_rules():
    prompt = build_extension_prompt(
        {
            "goal": "Open login modal",
            "page": {
                "url": "https://example.test",
                "title": "Example",
                "clickables": [{"text": "Here", "selector": "a.login"}],
            },
        }
    )

    assert "Open login modal" in prompt
    assert "https://example.test" in prompt
    assert "Do not edit files" in prompt
    assert "Here" in prompt


def test_browser_plan_prompt_requests_strict_json():
    prompt = build_extension_prompt({"mode": "browser_plan", "goal": "Click Here"})

    assert "Return strict JSON only." in prompt
    assert '"actions"' in prompt


def test_bridge_server_handler_can_be_constructed(tmp_path):
    handler = make_handler(
        BridgeServerConfig(
            token="test-token",
            cwd=tmp_path,
            codex_path=str(Path("missing-codex.exe")),
        )
    )

    assert handler.server_version == "ArafatAIBridge/0.1"

