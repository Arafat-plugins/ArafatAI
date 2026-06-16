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


def test_local_planner_answers_current_site_from_snapshot():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "tumi ekhon kon site e acho jano",
            "page": {
                "url": "https://directorist.com/pricing/",
                "title": "Directorist Pricing - Choose the Best Plan - Save Up to 35%",
            },
        },
        allow_question_fallback=False,
    )

    assert data["done"] is True
    assert data["actions"] == []
    assert data["questions"] == []
    assert "directorist.com" in data["reply"]
    assert "https://directorist.com/pricing/" in data["reply"]


def test_local_planner_explains_fast_local_answers_without_waiting_for_codex():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "eto fast ans kivabe diccho",
            "page": {
                "url": "https://directorist.com/pricing/",
                "title": "Directorist Pricing - Choose the Best Plan - Save Up to 35%",
            },
        },
        allow_question_fallback=False,
    )

    assert data["done"] is True
    assert data["actions"] == []
    assert data["questions"] == []
    assert "local route" in data["reply"]
    assert "No browser action is needed" in data["reasoning_summary"][-1]


def test_local_planner_lists_visible_pricing_from_snapshot():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "themes er pricing list kore dao ei site theke",
            "page": {
                "url": "https://directorist.com/pricing/",
                "title": "Directorist Pricing - Choose the Best Plan - Save Up to 35%",
                "visible_text": (
                    "Pricing plans Annual Lifetime 1 Site Starter For your first directory "
                    "$129 Save 20% $103 /Year Renews at $103/yr after first year Get Started "
                    "Most Popular Unlimited Sites Agency For agency & power users $219 Save 35% "
                    "$142 /Year Renews at $131/yr after first year Get Started 5 Sites Pro For "
                    "freelancers & growing directories $169 Save 30% $118 /Year Renews at $118/yr "
                    "after first year Get Started Limited Time Offer Own It Forever Mega Bundle "
                    "Directorist $749 20 site LTD FormGent $399 Unlimited Site Legal Page $199 "
                    "BUNDLE SAVINGS Save $548 Pay $799 /Once $1,347 separately"
                ),
            },
        },
        allow_question_fallback=False,
    )

    assert data["done"] is True
    assert data["actions"] == []
    assert data["questions"] == []
    assert "Starter (1 Site): $103/year" in data["reply"]
    assert "Agency (Unlimited Sites): $142/year" in data["reply"]
    assert "Pro (5 Sites): $118/year" in data["reply"]
    assert "Mega Bundle: $799/once" in data["reply"]


def test_local_planner_opens_theme_tab_before_answering_from_pricing_page():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "navbare theme tab ache oitate click kore theme gular ekta list kore dao amake",
            "page": {
                "url": "https://directorist.com/pricing/",
                "title": "Directorist Pricing - Choose the Best Plan - Save Up to 35%",
                "visible_text": (
                    "Pricing plans Annual Lifetime 1 Site Starter For your first directory "
                    "$129 Save 20% $103 /Year"
                ),
                "clickables": [
                    {"ref": "ref_4", "text": "Extensions", "href": "https://directorist.com/extensions/"},
                    {"ref": "ref_5", "text": "Themes", "href": "https://directorist.com/themes/"},
                    {"ref": "ref_8", "text": "Pricing", "href": "https://directorist.com/pricing/"},
                ],
            },
        },
        allow_question_fallback=False,
    )

    assert data["done"] is False
    assert data["actions"][0]["type"] == "navigate"
    assert data["actions"][0]["target"] == "https://directorist.com/themes/"
    assert "pricing list" not in data["reply"].lower()


def test_local_planner_lists_themes_after_theme_page_is_open():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "navbare theme tab ache oitate click kore theme gular ekta list kore dao amake",
            "page": {
                "url": "https://directorist.com/themes/",
                "title": "WordPress Directory Theme Collection for Directories",
                "visible_text": (
                    "dHotels New $69 The Best Hotel Directory WordPress Theme Live Preview Details "
                    "dClassified Trending $69 Best Classified Ads WordPress Theme Live Preview Details "
                    "OneListing Minimal WordPress Directory Theme (Free) Live Preview Details "
                    "OneListing Pro $69 WordPress Theme for Business Directory (Premium) Live Preview Details "
                    "dPlace $69 Tourism & Travel WordPress Directory Theme Live Preview Details "
                    "dRestaurant $69 Restaurant Directory Theme for WordPress Live Preview Details "
                    "dRealEstate $69 Real Estate WordPress Theme for Business Directory Live Preview Details "
                    "dCar $69 Car Directory WordPress Directory Theme Live Preview Details "
                    "dList $69 WordPress Theme for Business Directory Listing Live Preview Details "
                    "dService $69 Best Service WordPress Directory Theme Live Preview Details"
                ),
            },
        },
        allow_question_fallback=False,
    )

    assert data["done"] is True
    assert data["actions"] == []
    assert "dHotels - $69" in data["reply"]
    assert "OneListing - Free" in data["reply"]
    assert "OneListing Pro - $69" in data["reply"]
    assert "dService - $69" in data["reply"]


def test_local_planner_waits_when_theme_page_is_open_but_list_not_ready():
    data = parse_reply(
        {
            "mode": "agent_task",
            "goal": "navbare theme tab ache oitate click kore theme gular ekta list kore dao amake",
            "page": {
                "url": "https://directorist.com/themes/",
                "title": "WordPress Directory Theme Collection for Directories",
                "visible_text": "WordPress themes for building feature-rich listing websites. Loading...",
                "clickables": [{"ref": "ref_5", "text": "Themes", "href": "https://directorist.com/themes/"}],
            },
            "task_state": {"observations": []},
        },
        allow_question_fallback=False,
    )

    assert data["done"] is False
    assert data["questions"] == []
    assert data["actions"][0]["type"] == "wait"
    assert data["actions"][0]["target"] == "theme-list"


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
