import json
from pathlib import Path

from arafatai.bridge.core_reasoner import normalize_agent_contract_json, reason_with_python_core
from arafatai.bridge.server import BridgeServerConfig, make_handler


def test_python_core_returns_sidebar_contract_for_obvious_browser_action():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "youtube a jao",
            "page": {"url": "chrome://newtab/", "title": "New Tab"},
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert result.source == "python-core-local-planner"
    assert payload["actions"][0]["type"] == "navigate"
    assert payload["actions"][0]["target"] == "https://www.youtube.com/"
    assert payload["done"] is False
    assert isinstance(payload["reasoning_summary"], list)


def test_python_core_uses_evidence_first_policy_for_support_work():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Fix Directorist geo search no results in child theme",
            "page": {"url": "https://example.test/directory/", "title": "Directory"},
            "task_classification": {
                "task_type": "engineering_fix",
                "domain": "directorist",
                "risk_level": "needs_confirmation",
                "evidence_needed": ["root_cause_summary", "target_surface", "verification_result"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert result.source == "python-core-policy"
    assert "evidence before claiming a fix" in payload["reply"]
    assert payload["actions"][0]["type"] == "tool"
    assert payload["actions"][0]["tool"] == "http_get"
    assert payload["actions"][0]["input"]["url"] == "https://example.test/directory/"
    assert payload["done"] is False


def test_python_core_asks_for_next_target_after_runtime_evidence():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Fix Directorist geo search no results in child theme",
            "page": {"url": "https://example.test/directory/", "title": "Directory"},
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "http", "title": "HTTP GET", "summary": "Returned 200."},
                ]
            },
            "task_classification": {
                "task_type": "engineering_fix",
                "domain": "directorist",
                "risk_level": "needs_confirmation",
                "evidence_needed": ["root_cause_summary", "target_surface", "verification_result"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert result.source == "python-core-policy"
    assert payload["actions"] == []
    assert payload["questions"]
    assert payload["needs_approval"] is True


def test_python_core_continues_wordpress_login_choice_when_credentials_supplied():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": (
                "Site admin: https://example.test/wp-admin\n"
                "Username: dev-user\n"
                "Password: secret-pass\n"
                "Investigate only."
            ),
            "page": {
                "url": "https://example.test/wp-login.php",
                "title": "Log In - WordPress",
                "visible_text": "Log in with GoDaddy OR Log in with username and password",
            },
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "http", "title": "HTTP GET", "summary": "Returned 200."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["page_snapshot", "http_request"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert payload["questions"] == []
    assert payload["actions"][0]["type"] == "click"
    assert payload["actions"][0]["target"] == "text=Log in with username and password"
    assert payload["needs_approval"] is False


def test_python_core_submits_wordpress_login_form_when_credentials_supplied():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": (
                "Site admin: https://example.test/wp-admin\n"
                "user: dev-user\n"
                "PW: secret-pass\n"
                "Investigation only."
            ),
            "page": {
                "url": "https://example.test/wp-login.php",
                "title": "Log In - WordPress",
                "forms": [
                    {
                        "fields": [
                            {"selector": "input[name=\"log\"]", "name": "log", "type": "text"},
                            {"selector": "input[name=\"pwd\"]", "name": "pwd", "type": "password"},
                        ]
                    }
                ],
            },
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "http", "title": "HTTP GET", "summary": "Returned 200."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["page_snapshot", "http_request"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert payload["questions"] == []
    assert [action["type"] for action in payload["actions"]] == ["type", "type", "click"]
    assert payload["actions"][0]["target"] == 'input[name="log"]'
    assert payload["actions"][0]["value"] == "dev-user"
    assert payload["actions"][1]["target"] == 'input[name="pwd"]'
    assert payload["actions"][1]["value"] == "secret-pass"
    assert payload["actions"][2]["target"] == "#wp-submit"


def test_python_core_allows_approved_wordpress_login_click():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Approved: click the visible WordPress Log In button to enter the dashboard for read-only investigation.",
            "page": {
                "url": "https://example.test/wp-login.php",
                "title": "Log In - WordPress",
                "clickables": [{"text": "Log In", "selector": "#wp-submit"}],
            },
            "task_classification": {
                "task_type": "risky_action",
                "domain": "wordpress",
                "risk_level": "needs_confirmation",
                "evidence_needed": ["target_confirmation", "wordpress_session"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert payload["questions"] == []
    assert payload["actions"][0]["type"] == "click"
    assert payload["actions"][0]["target"] == "#wp-submit"
    assert payload["needs_approval"] is False


def test_python_core_policy_allows_approved_wordpress_login_click_after_evidence():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": (
                "Approved: click the visible WordPress Log In button to enter the dashboard for read-only issue "
                "investigation. Do not change settings, edit content, publish, delete, or save anything."
            ),
            "page": {
                "url": "https://example.test/wp-login.php",
                "title": "Log In - WordPress",
                "clickables": [{"text": "Log In", "selector": "#wp-submit"}],
            },
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "http", "title": "HTTP GET", "summary": "Returned 200."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["page_snapshot", "wordpress_session"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert payload["questions"] == []
    assert payload["actions"][0]["type"] == "click"
    assert payload["actions"][0]["target"] == "#wp-submit"
    assert payload["needs_approval"] is False


def test_python_core_reports_godaddy_sso_blocker_before_login_actions():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": (
                "Check this WordPress issue. Site admin: https://2ni.3cd.myftpupload.com/wp-admin "
                "Username: dev-user Password: secret-pass"
            ),
            "page": {
                "url": (
                    "https://sso.godaddy.com/?realm=idp&path=%2Fmwp%2Fsite%2Fabc%2Fsso"
                    "%3Fpath%3D%2Fwp-admin%26type%3Dwp%26origin%3Dwp-login"
                ),
                "title": "Sign In to Your Account - GoDaddy",
                "visible_text": "GoDaddy Sign in Username or Customer # Password Sign In",
                "forms": [
                    {
                        "fields": [
                            {"name": "username", "type": "text"},
                            {"name": "password", "type": "password"},
                        ]
                    }
                ],
            },
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "http", "title": "HTTP GET", "summary": "Returned 200."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["page_snapshot", "wordpress_session"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert "GoDaddy SSO" in payload["reply"]
    assert payload["actions"] == []
    assert payload["questions"]
    assert payload["needs_approval"] is True


def test_python_core_summarizes_directorist_dependency_root_cause():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Check the WordPress homepage issue after editing with Elementor.",
            "page": {
                "url": "https://example.test/wp-admin/plugins.php?plugin_status=all&paged=1&s",
                "title": "Plugins - Nightlife Community Hub - WordPress",
                "visible_text": (
                    "Directorist - Business Directory Solution Activate | Delete "
                    "Required By: Directorist AddonsKit for Elementor. "
                    "Directorist AddonsKit for Elementor Activate | Delete "
                    "Requires: Directorist: AI-Powered Business Directory Plugin, "
                    "Elementor Website Builder. "
                    "This plugin cannot be activated because required plugins are missing or inactive. "
                    "Elementor Settings | Deactivate"
                ),
            },
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "browser", "title": "Plugins page", "summary": "Observed WordPress plugins page."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["page_snapshot", "wordpress_session", "active_theme_or_plugin"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert "Directorist plugin dependency/state problem" in payload["reply"]
    assert payload["actions"] == []
    assert payload["questions"]
    assert "activat" in payload["questions"][0]
    assert payload["done"] is False
    assert payload["needs_approval"] is True


def test_python_core_activates_only_base_directorist_after_approval():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Yes, approved. Activate the required Directorist plugin and retest.",
            "page": {
                "url": "https://example.test/wp-admin/plugins.php?plugin_status=all&paged=1&s",
                "title": "Plugins - Nightlife Community Hub - WordPress",
                "visible_text": (
                    "Directorist - Business Directory Solution Activate | Delete "
                    "Required By: Directorist AddonsKit for Elementor. "
                    "Directorist AddonsKit for Elementor Activate | Delete "
                    "Requires: Directorist: AI-Powered Business Directory Plugin. "
                    "This plugin cannot be activated because required plugins are missing or inactive."
                ),
                "clickables": [
                    {
                        "text": "Activate",
                        "ref": "ref_addonskit",
                        "href": "https://example.test/wp-admin/plugins.php?action=activate&plugin=directorist-addonskit%2Fdirectorist-addonskit.php&_wpnonce=addons",
                    },
                    {
                        "text": "Activate",
                        "ref": "ref_base_directorist",
                        "href": "https://example.test/wp-admin/plugins.php?action=activate&plugin=directorist%2Fdirectorist-base.php&_wpnonce=base",
                    },
                ],
            },
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "browser", "title": "Plugins page", "summary": "Observed WordPress plugins page."},
                ]
            },
            "conversation_memory": {
                "summary": "FLUID found a Directorist plugin dependency/state problem and asked for activation approval."
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["page_snapshot", "wordpress_session", "active_theme_or_plugin"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert payload["questions"] == []
    assert payload["actions"] == [
        {
            "type": "click",
            "target": "ref_base_directorist",
            "value": "",
            "reason": "Activate the required base Directorist plugin from its exact Plugins-page control.",
        }
    ]
    assert payload["done"] is False
    assert payload["needs_approval"] is False


def test_python_core_retests_homepage_after_directorist_activation():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Yes, approved. Activate the required Directorist plugin and retest.",
            "page": {
                "url": "https://example.test/wp-admin/plugins.php?plugin_status=all&paged=1&s",
                "title": "Plugins - Nightlife Community Hub - WordPress",
                "visible_text": "Plugin activated. Directorist - Business Directory Solution Deactivate",
                "clickables": [
                    {
                        "text": "Deactivate",
                        "ref": "ref_deactivate_directorist",
                        "href": "https://example.test/wp-admin/plugins.php?action=deactivate&plugin=directorist%2Fdirectorist-base.php&_wpnonce=base",
                    }
                ],
            },
            "task_state": {
                "observations": [
                    {
                        "ok": True,
                        "message": "click completed.",
                        "action": {
                            "type": "click",
                            "target": "ref_base_directorist",
                            "reason": "Activate the required base Directorist plugin from its exact Plugins-page control.",
                        },
                        "result": {
                            "type": "click",
                            "href": "https://example.test/wp-admin/plugins.php?action=activate&plugin=directorist%2Fdirectorist-base.php&_wpnonce=base",
                        },
                    }
                ]
            },
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "browser", "title": "Plugins page", "summary": "Observed WordPress plugins page."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["page_snapshot", "wordpress_session", "verification_result"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert payload["questions"] == []
    assert payload["actions"] == [
        {
            "type": "navigate",
            "target": "https://example.test/",
            "value": "https://example.test/",
            "reason": "Open the site homepage to verify the Directorist layout after activation.",
        }
    ]
    assert payload["done"] is False
    assert payload["needs_approval"] is False


def test_python_core_marks_directorist_homepage_retest_fixed():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Retest the homepage after Directorist activation.",
            "page": {
                "url": "https://example.test/",
                "title": "Nightlife Community Hub",
                "layout": {
                    "viewport_width": 1440,
                    "document_width": 1440,
                    "horizontal_overflow": False,
                },
                "visible_text": "Act Directory Filters Search 12 Items Found Performer/Act Name La Scarlet Burlesque",
                "clickables": [
                    {"text": "Filters", "ref": "ref_filters"},
                    {"text": "Search", "ref": "ref_search"},
                ],
                "images": [
                    {"alt": "La Scarlet", "box": {"width": 280, "height": 180}},
                ],
            },
            "task_state": {
                "observations": [
                    {
                        "ok": True,
                        "message": "click completed.",
                        "action": {
                            "type": "click",
                            "target": "ref_base_directorist",
                            "reason": "Activate the required base Directorist plugin from its exact Plugins-page control.",
                        },
                        "result": {
                            "href": "https://example.test/wp-admin/plugins.php?action=activate&plugin=directorist%2Fdirectorist-base.php&_wpnonce=base",
                        },
                    }
                ]
            },
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "browser", "title": "Homepage", "summary": "Observed homepage after activation."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["verification_result"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert "looks fixed" in payload["reply"]
    assert payload["actions"] == []
    assert payload["questions"] == []
    assert payload["done"] is True
    assert payload["needs_approval"] is False


def test_python_core_marks_directorist_homepage_retest_still_broken():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Retest the homepage after Directorist activation.",
            "page": {
                "url": "https://example.test/",
                "title": "Nightlife Community Hub",
                "layout": {
                    "viewport_width": 390,
                    "document_width": 760,
                    "horizontal_overflow": True,
                },
                "visible_text": (
                    "Search More Filters Apply Filters Reset Filters Title Search Filters "
                    "More Filters Apply Filters Reset Filters Performer/Act Name"
                ),
                "clickables": [
                    {"text": "Apply Filters", "ref": "ref_apply_1"},
                    {"text": "Reset Filters", "ref": "ref_reset_1"},
                ],
            },
            "task_state": {
                "observations": [
                    {
                        "ok": True,
                        "message": "click completed.",
                        "action": {
                            "type": "click",
                            "target": "ref_base_directorist",
                            "reason": "Activate the required base Directorist plugin from its exact Plugins-page control.",
                        },
                        "result": {
                            "href": "https://example.test/wp-admin/plugins.php?action=activate&plugin=directorist%2Fdirectorist-base.php&_wpnonce=base",
                        },
                    }
                ]
            },
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "browser", "title": "Homepage", "summary": "Observed homepage after activation."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["verification_result"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert "still looks broken" in payload["reply"]
    assert payload["actions"] == []
    assert payload["questions"]
    assert payload["done"] is False
    assert payload["needs_approval"] is True


def test_python_core_collects_stronger_evidence_when_homepage_retest_is_insufficient():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Retest the homepage after Directorist activation.",
            "page": {
                "url": "https://example.test/",
                "title": "Nightlife Community Hub",
                "layout": {
                    "viewport_width": 1440,
                    "document_width": 1440,
                    "horizontal_overflow": False,
                },
                "visible_text": "Nightlife Community Hub Resources Info Connect",
                "clickables": [],
                "images": [],
            },
            "task_state": {
                "observations": [
                    {
                        "ok": True,
                        "message": "click completed.",
                        "action": {
                            "type": "click",
                            "target": "ref_base_directorist",
                            "reason": "Activate the required base Directorist plugin from its exact Plugins-page control.",
                        },
                        "result": {
                            "href": "https://example.test/wp-admin/plugins.php?action=activate&plugin=directorist%2Fdirectorist-base.php&_wpnonce=base",
                        },
                    },
                    {
                        "ok": True,
                        "message": "Observed current page.",
                        "action": {
                            "type": "observe",
                            "target": "current-tab",
                            "reason": "Capture the homepage snapshot after Directorist activation.",
                        },
                    },
                ]
            },
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "browser", "title": "Homepage", "summary": "Observed homepage after activation."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["verification_result"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert payload["questions"] == []
    assert payload["actions"][0]["type"] == "tool"
    assert payload["actions"][0]["tool"] == "chrome_cdp_check"
    assert payload["actions"][0]["input"]["navigate_url"] == "https://example.test/"
    assert payload["actions"][0]["input"]["selector"] == "body"
    assert payload["actions"][0]["input"]["screenshot"] is True
    assert payload["done"] is False
    assert payload["needs_approval"] is False


def test_python_core_does_not_repeat_stronger_homepage_evidence_request():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Retest the homepage after Directorist activation.",
            "page": {
                "url": "https://example.test/",
                "title": "Nightlife Community Hub",
                "visible_text": "Nightlife Community Hub Resources Info Connect",
            },
            "task_state": {
                "observations": [
                    {
                        "ok": True,
                        "action": {
                            "type": "click",
                            "target": "ref_base_directorist",
                            "reason": "Activate the required base Directorist plugin from its exact Plugins-page control.",
                        },
                        "result": {
                            "href": "https://example.test/wp-admin/plugins.php?action=activate&plugin=directorist%2Fdirectorist-base.php&_wpnonce=base",
                        },
                    },
                    {
                        "ok": True,
                        "action": {"type": "observe", "reason": "Capture the homepage snapshot after Directorist activation."},
                    },
                ]
            },
            "task_memory": {
                "evidence": [
                    {"type": "classification", "title": "Initial task classification"},
                    {"type": "browser_verification", "title": "Chrome CDP check: body", "summary": "Assertion passed."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["verification_result"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert payload["actions"] == []
    assert payload["questions"]
    assert payload["needs_approval"] is True


def test_python_core_uses_chrome_cdp_homepage_evidence_to_mark_fixed():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Retest the homepage after Directorist activation.",
            "page": {
                "url": "https://example.test/",
                "title": "Nightlife Community Hub",
                "visible_text": "Nightlife Community Hub Resources Info Connect",
            },
            "task_state": {
                "observations": [
                    {
                        "ok": True,
                        "action": {
                            "type": "click",
                            "target": "ref_base_directorist",
                            "reason": "Activate the required base Directorist plugin from its exact Plugins-page control.",
                        },
                        "result": {
                            "href": "https://example.test/wp-admin/plugins.php?action=activate&plugin=directorist%2Fdirectorist-base.php&_wpnonce=base",
                        },
                    },
                    {
                        "ok": True,
                        "message": "Chrome CDP check: body. Assertion passed. Screenshot: runs/browser-evidence/directorist-homepage-retest.png",
                        "action": {
                            "type": "tool",
                            "tool": "chrome_cdp_check",
                            "target": "chrome_cdp_check",
                        },
                        "result": {
                            "ok": True,
                            "result": {
                                "ok": True,
                                "target": {"url": "https://example.test/"},
                                "assertion": {
                                    "ok": True,
                                    "selector": "body",
                                    "visible": True,
                                    "text": "Act Directory Filters Search 12 Items Found Performer/Act Name La Scarlet Burlesque",
                                    "layout": {
                                        "viewport_width": 1440,
                                        "document_width": 1440,
                                        "horizontal_overflow": False,
                                    },
                                    "clickables": [{"text": "Filters"}, {"text": "Search"}],
                                    "images": [{"alt": "La Scarlet", "box": {"width": 280, "height": 180}}],
                                },
                                "screenshot": {"path": "runs/browser-evidence/directorist-homepage-retest.png"},
                            },
                        },
                    },
                ]
            },
            "task_memory": {
                "evidence": [
                    {"type": "browser_verification", "title": "Chrome CDP check: body", "summary": "Assertion passed."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["verification_result"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert "looks fixed" in payload["reply"]
    assert payload["actions"] == []
    assert payload["questions"] == []
    assert payload["done"] is True
    assert payload["needs_approval"] is False


def test_python_core_uses_chrome_cdp_homepage_evidence_to_mark_still_broken():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Retest the homepage after Directorist activation.",
            "page": {
                "url": "https://example.test/",
                "title": "Nightlife Community Hub",
                "visible_text": "Nightlife Community Hub Resources Info Connect",
            },
            "task_state": {
                "observations": [
                    {
                        "ok": True,
                        "action": {
                            "type": "click",
                            "target": "ref_base_directorist",
                            "reason": "Activate the required base Directorist plugin from its exact Plugins-page control.",
                        },
                        "result": {
                            "href": "https://example.test/wp-admin/plugins.php?action=activate&plugin=directorist%2Fdirectorist-base.php&_wpnonce=base",
                        },
                    },
                    {
                        "ok": True,
                        "message": "Chrome CDP check: body. Assertion passed.",
                        "action": {
                            "type": "tool",
                            "tool": "chrome_cdp_check",
                            "target": "chrome_cdp_check",
                        },
                        "result": {
                            "ok": True,
                            "result": {
                                "ok": True,
                                "target": {"url": "https://example.test/"},
                                "assertion": {
                                    "ok": True,
                                    "selector": "body",
                                    "visible": True,
                                    "text": (
                                        "Search More Filters Apply Filters Reset Filters Title Search Filters "
                                        "More Filters Apply Filters Reset Filters Performer/Act Name"
                                    ),
                                    "layout": {
                                        "viewport_width": 390,
                                        "document_width": 760,
                                        "horizontal_overflow": True,
                                    },
                                    "clickables": [{"text": "Apply Filters"}, {"text": "Reset Filters"}],
                                    "images": [],
                                },
                            },
                        },
                    },
                ]
            },
            "task_memory": {
                "evidence": [
                    {"type": "browser_verification", "title": "Chrome CDP check: body", "summary": "Assertion passed."},
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["verification_result"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert "still looks broken" in payload["reply"]
    assert "Horizontal overflow remains" in payload["reply"]
    assert payload["actions"] == []
    assert payload["questions"]
    assert payload["done"] is False
    assert payload["needs_approval"] is True


def test_python_core_uses_stored_chrome_cdp_evidence_payload_to_mark_fixed():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Retest the homepage after Directorist activation.",
            "page": {
                "url": "https://example.test/",
                "title": "Nightlife Community Hub",
                "visible_text": "Nightlife Community Hub Resources Info Connect",
            },
            "task_state": {
                "observations": [
                    {
                        "ok": True,
                        "action": {
                            "type": "click",
                            "target": "ref_base_directorist",
                            "reason": "Activate the required base Directorist plugin from its exact Plugins-page control.",
                        },
                        "result": {
                            "href": "https://example.test/wp-admin/plugins.php?action=activate&plugin=directorist%2Fdirectorist-base.php&_wpnonce=base",
                        },
                    },
                    {
                        "ok": True,
                        "action": {"type": "observe", "reason": "Capture the homepage snapshot after Directorist activation."},
                    },
                ]
            },
            "task_memory": {
                "evidence": [
                    {
                        "type": "browser_verification",
                        "title": "Chrome CDP check: body",
                        "summary": "Assertion passed. Screenshot: runs/browser-evidence/directorist-homepage-retest.png",
                        "payload": {
                            "tool": "chrome_cdp_check",
                            "result": {
                                "ok": True,
                                "target": {"url": "https://example.test/"},
                                "assertion": {
                                    "ok": True,
                                    "selector": "body",
                                    "visible": True,
                                    "text": "Act Directory Filters Search 12 Items Found Performer/Act Name La Scarlet Burlesque",
                                    "layout": {
                                        "viewport_width": 1440,
                                        "document_width": 1440,
                                        "horizontal_overflow": False,
                                    },
                                    "clickables": [{"text": "Filters"}, {"text": "Search"}],
                                    "images": [{"alt": "La Scarlet", "box": {"width": 280, "height": 180}}],
                                },
                            },
                        },
                    },
                ]
            },
            "task_classification": {
                "task_type": "investigation",
                "domain": "wordpress",
                "risk_level": "safe",
                "evidence_needed": ["verification_result"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert "looks fixed" in payload["reply"]
    assert payload["actions"] == []
    assert payload["questions"] == []
    assert payload["done"] is True
    assert payload["needs_approval"] is False


def test_python_core_still_blocks_destructive_approved_action():
    result = reason_with_python_core(
        {
            "mode": "agent_task",
            "goal": "Approved: reset this WordPress site after login.",
            "page": {
                "url": "https://example.test/wp-login.php",
                "title": "Log In - WordPress",
                "clickables": [{"text": "Log In", "selector": "#wp-submit"}],
            },
            "task_classification": {
                "task_type": "risky_action",
                "domain": "wordpress",
                "risk_level": "needs_confirmation",
                "evidence_needed": ["target_confirmation", "wordpress_session"],
            },
        }
    )
    payload = json.loads(result.text)

    assert result.ok is True
    assert payload["actions"] == []
    assert payload["questions"]
    assert payload["needs_approval"] is True


def test_python_core_normalizes_malformed_provider_text():
    payload = json.loads(normalize_agent_contract_json("plain answer"))

    assert payload["reply"] == "plain answer"
    assert payload["reasoning_summary"] == []
    assert payload["questions"] == []
    assert payload["actions"] == []
    assert payload["done"] is False
    assert payload["needs_approval"] is False


def test_python_bridge_server_can_use_core_provider(tmp_path):
    handler = make_handler(
        BridgeServerConfig(
            token="test-token",
            cwd=tmp_path,
            codex_path=str(Path("missing-codex.exe")),
            provider="core",
        )
    )

    assert handler.server_version == "ArafatAIBridge/0.1"
