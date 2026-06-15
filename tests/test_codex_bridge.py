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
    assert '"reasoning_summary"' in prompt
    assert '"questions"' in prompt
    assert "navigate|search|click|type|wait|observe" in prompt


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
