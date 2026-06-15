from pathlib import Path
import json

from arafatai.bridge.codex_cli import CodexCLIConfig, build_extension_prompt, compact_page
from arafatai.bridge.codex_cli import CodexCLIBridge
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
    assert '"reasoning_summary"' in prompt
    assert '"questions"' in prompt
    assert "navigate|search|click|type|press|wait|observe" in prompt
    assert "Use ref ids from page.accessibility_tree" in prompt
    assert 'never use generic selectors like "a", "button", "input"' in prompt


def test_agent_chat_prompt_keeps_own_ai_contract_provider_independent():
    prompt = build_extension_prompt(
        {
            "mode": "agent_chat",
            "goal": "Explain this page",
            "approval_policy": "chat-only",
        }
    )

    assert "Arafat's own AI" in prompt
    assert "same JSON contract" in prompt
    assert "Do not reveal hidden chain-of-thought" in prompt
    assert '"needs_approval":true' in prompt
    assert "keep actions empty" in prompt


def test_agent_chat_safe_actions_can_search_from_chrome_newtab():
    prompt = build_extension_prompt(
        {
            "mode": "agent_chat",
            "goal": "image search koro",
            "approval_policy": "chat-safe-actions",
            "page": {"url": "chrome://newtab/", "title": "New Tab"},
        }
    )

    assert "return one search or navigate action" in prompt
    assert "chrome://newtab" in prompt
    assert "use search or navigate" in prompt


def test_agent_task_prompt_supports_action_observation_loop():
    prompt = build_extension_prompt(
        {
            "mode": "agent_task",
            "goal": "set up n8n",
            "approval_policy": "auto-safe-actions",
            "task_state": {"step": 2, "observations": [{"ok": True, "message": "Opened n8n."}]},
        }
    )

    assert "act like a browser agent" in prompt
    assert "task_state observations" in prompt
    assert "credentials, payment, CAPTCHA" in prompt
    assert '"done":true|false' in prompt


def test_bridge_server_handler_can_be_constructed(tmp_path):
    handler = make_handler(
        BridgeServerConfig(
            token="test-token",
            cwd=tmp_path,
            codex_path=str(Path("missing-codex.exe")),
        )
    )

    assert handler.server_version == "ArafatAIBridge/0.1"


def test_bridge_server_default_timeout_supports_longer_tasks():
    assert BridgeServerConfig().timeout_seconds == 300


def test_compact_page_limits_large_snapshots():
    page = compact_page(
        {
            "url": "https://example.test",
            "title": "Huge",
            "accessibility_tree": "x" * 7000,
            "visible_text": "y" * 2000,
            "clickables": [{"ref": f"ref_{i}", "text": "Button", "selector": "button"} for i in range(100)],
        }
    )

    assert page["url"] == "https://example.test"
    assert len(page["accessibility_tree"]) < 6100
    assert len(page["visible_text"]) < 1300
    assert len(page["clickables"]) == 80


def test_codex_bridge_local_planner_finishes_after_safe_navigation():
    bridge = CodexCLIBridge(CodexCLIConfig(codex_path=str(Path("missing-codex.exe"))))

    first = bridge.reason(
        {
            "mode": "agent_task",
            "goal": "youtube a jao",
            "page": {"url": "chrome://newtab/", "title": "New Tab"},
        }
    )
    first_payload = json.loads(first.text)

    assert first.ok is True
    assert first.source == "local-planner"
    assert first_payload["actions"][0]["type"] == "navigate"

    second = bridge.reason(
        {
            "mode": "agent_task",
            "goal": "youtube a jao",
            "page": {"url": "https://www.youtube.com/", "title": "YouTube"},
            "task_state": {
                "observations": [
                    {
                        "kind": "observation",
                        "status": "running",
                        "message": "Opened: https://www.youtube.com/",
                    }
                ]
            },
        }
    )
    second_payload = json.loads(second.text)

    assert second.ok is True
    assert second.source == "local-planner"
    assert second_payload["done"] is True
    assert second_payload["actions"] == []
