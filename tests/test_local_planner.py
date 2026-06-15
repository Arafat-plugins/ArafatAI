import json

from arafatai.bridge.local_planner import build_local_agent_reply


def parse_reply(body, **kwargs):
    reply = build_local_agent_reply(body, **kwargs)
    assert reply is not None
    return json.loads(reply)


def test_local_planner_opens_youtube_without_codex():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "youtube a jao",
            "page": {"url": "chrome://newtab/", "title": "New Tab"},
        },
        allow_question_fallback=False,
    )

    assert data["actions"][0]["type"] == "navigate"
    assert data["actions"][0]["target"] == "https://www.youtube.com/"
    assert data["reasoning_summary"]


def test_local_planner_builds_google_image_search():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "cat logo image search koro",
            "page": {"url": "chrome://newtab/", "title": "New Tab"},
        },
        allow_question_fallback=False,
    )

    assert data["actions"][0]["type"] == "search"
    assert data["actions"][0]["mode"] == "images"
    assert data["actions"][0]["value"] == "cat logo"


def test_local_planner_marks_youtube_navigation_done_after_open():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "youtube a jao",
            "page": {"url": "https://www.youtube.com/", "title": "YouTube"},
        },
        allow_question_fallback=False,
    )

    assert data["done"] is True
    assert data["actions"] == []


def test_local_planner_marks_google_image_search_done_after_open():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "cat logo image search koro",
            "page": {
                "url": "https://www.google.com/search?q=cat+logo&tbm=isch",
                "title": "cat logo - Google Search",
            },
        },
        allow_question_fallback=False,
    )

    assert data["done"] is True
    assert data["actions"] == []


def test_local_planner_demo_opens_example_without_clicking_generic_link():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "tumi testing mode a acho so ekta kichu kore dekhao",
            "page": {"url": "chrome://newtab/", "title": "New Tab"},
        },
        allow_question_fallback=False,
    )

    assert data["actions"][0]["type"] == "navigate"
    assert data["actions"][0]["target"] == "https://example.com/"


def test_local_planner_demo_stops_after_example_is_open():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "tumi testing mode a acho so ekta kichu kore dekhao",
            "page": {"url": "https://example.com/", "title": "Example Domain"},
        },
        allow_question_fallback=False,
    )

    assert data["done"] is True
    assert data["actions"] == []


def test_local_planner_blocks_risky_actions():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "delete this post",
            "page": {"url": "https://example.test", "title": "Admin"},
        },
        allow_question_fallback=False,
    )

    assert data["actions"] == []
    assert data["needs_approval"] is True
    assert data["questions"]


def test_local_planner_defers_unknown_goal_when_requested():
    reply = build_local_agent_reply(
        {
            "mode": "agent_task",
            "goal": "set up my whole n8n workflow",
            "page": {"url": "https://n8n.io", "title": "n8n"},
        },
        allow_question_fallback=False,
    )

    assert reply is None
