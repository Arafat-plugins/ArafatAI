"""Python-first sidebar reasoning contract.

This module is the first stable seam between the Chrome sidebar bridge and the
Python ArafatAI core. It deliberately keeps the same JSON contract that the
Node bridge and extension already use.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Any
from urllib.parse import urlparse

from arafatai.bridge.local_planner import build_local_agent_reply


AGENT_CONTRACT_DEFAULT: dict[str, Any] = {
    "reply": "",
    "reasoning_summary": [],
    "questions": [],
    "actions": [],
    "done": False,
    "needs_approval": False,
}


@dataclass(frozen=True)
class CoreReasonerResponse:
    ok: bool
    text: str
    source: str
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "text": self.text,
            "source": self.source,
            "error": self.error,
        }


def reason_with_python_core(body: dict[str, Any]) -> CoreReasonerResponse:
    """Return a sidebar-compatible provider response.

    The current core policy is intentionally conservative:
    - obvious safe browser actions are handled by the deterministic local
      planner;
    - unknown or complex support work is converted into an evidence-first
      response instead of a guessed fix.
    """

    classification = body.get("task_classification") if isinstance(body.get("task_classification"), dict) else {}
    task_type = str(classification.get("task_type") or "")
    if task_type in {"investigation", "engineering_fix", "review_only"}:
        return CoreReasonerResponse(
            ok=True,
            text=normalize_agent_contract_json(build_evidence_first_reply(body)),
            source="python-core-policy",
        )

    direct = build_local_agent_reply(body, allow_question_fallback=False)
    if direct:
        return CoreReasonerResponse(
            ok=True,
            text=normalize_agent_contract_json(direct),
            source="python-core-local-planner",
        )

    return CoreReasonerResponse(
        ok=True,
        text=normalize_agent_contract_json(build_evidence_first_reply(body)),
        source="python-core-policy",
    )


def build_evidence_first_reply(body: dict[str, Any]) -> str:
    classification = body.get("task_classification") if isinstance(body.get("task_classification"), dict) else {}
    task_type = str(classification.get("task_type") or "unknown")
    domain = str(classification.get("domain") or "unknown")
    evidence_needed = classification.get("evidence_needed") if isinstance(classification.get("evidence_needed"), list) else []
    page = body.get("page") if isinstance(body.get("page"), dict) else {}
    task_memory = body.get("task_memory") if isinstance(body.get("task_memory"), dict) else {}
    evidence = task_memory.get("evidence") if isinstance(task_memory.get("evidence"), list) else []
    has_runtime_evidence = any(
        isinstance(item, dict) and str(item.get("type") or "") not in {"", "classification"}
        for item in evidence
    )
    page_label = page.get("url") or page.get("title") or "current page"

    if task_type in {"investigation", "engineering_fix", "review_only"}:
        evidence_text = ", ".join(str(item) for item in evidence_needed[:4] if item) or "page evidence"
        if has_runtime_evidence:
            auth_blocker_reply = build_auth_blocker_reply(body)
            if auth_blocker_reply:
                return auth_blocker_reply

            login_reply = build_wordpress_login_continuation(body)
            if login_reply:
                return login_reply

            homepage_retest_reply = build_directorist_homepage_retest_reply(body)
            if homepage_retest_reply:
                return homepage_retest_reply

            plugin_dependency_reply = build_wordpress_plugin_dependency_reply(body)
            if plugin_dependency_reply:
                return plugin_dependency_reply

            return json.dumps(
                {
                    "reply": (
                        "Initial evidence is logged. I need the next concrete target before changing code, "
                        "such as the WordPress admin route, local child-theme path, or the exact file to inspect."
                    ),
                    "reasoning_summary": [
                        f"Mode: {task_type}/{domain}.",
                        f"Evidence logged: {len(evidence)} item(s).",
                        "Code changes stay blocked until the target surface and verification path are known.",
                    ],
                    "questions": ["Which admin URL, local theme path, or source file should I inspect next?"],
                    "actions": [],
                    "done": False,
                    "needs_approval": True,
                },
                ensure_ascii=False,
            )

        reply = (
            "I need evidence before claiming a fix. I will start from the current page, "
            "then use the bridge tools for WordPress/file/test evidence when needed."
        )
        reasoning = [
            f"Mode: {task_type}/{domain}.",
            f"Evidence needed: {evidence_text}.",
            f"Current target: {page_label}.",
        ]
        page_url = str(page.get("url") or "")
        actions = [
            {
                "type": "tool",
                "tool": "http_get",
                "target": "http_get",
                "input": {"url": page_url},
                "reason": "Capture public page HTTP evidence before planning a fix.",
            }
        ] if page_url.startswith(("http://", "https://")) else [
            {
                "type": "observe",
                "target": "current-tab",
                "value": "",
                "reason": "Capture the current page before planning a fix.",
            }
        ]
        return json.dumps(
            {
                "reply": reply,
                "reasoning_summary": reasoning,
                "questions": [],
                "actions": actions,
                "done": False,
                "needs_approval": False,
            },
            ensure_ascii=False,
        )

    return json.dumps(
        {
            "reply": "I need one more detail before acting.",
            "reasoning_summary": ["The Python core could not map this to one safe, obvious next step."],
            "questions": ["What exact page, search topic, button text, or URL should I use?"],
            "actions": [],
            "done": False,
            "needs_approval": True,
        },
        ensure_ascii=False,
    )


def build_directorist_homepage_retest_reply(body: dict[str, Any]) -> str:
    if not directorist_activation_completed(body):
        return ""

    page = body.get("page") if isinstance(body.get("page"), dict) else {}
    current_url = str(page.get("url") or "")
    homepage_url = homepage_url_from_page(page)
    if not homepage_url:
        return ""

    if is_same_url_without_path(current_url, homepage_url) and "/wp-admin/" not in current_url:
        retest_result = directorist_homepage_retest_result(body)
        if retest_result:
            return retest_result

        if homepage_retest_observed(body):
            stronger_evidence_action = directorist_homepage_stronger_evidence_action(body)
            if stronger_evidence_action and not homepage_stronger_evidence_requested(body):
                return json.dumps(
                    {
                        "reply": (
                            "The homepage snapshot is not enough to decide fixed vs still broken. I will collect one "
                            "stronger read-only browser evidence pass with a desktop viewport screenshot."
                        ),
                        "reasoning_summary": [
                            "The base Directorist activation action completed.",
                            "The homepage was opened and observed.",
                            "The current snapshot does not prove fixed or still broken.",
                            "The next action is read-only browser verification, not a site setting or file change.",
                        ],
                        "questions": [],
                        "actions": [stronger_evidence_action],
                        "done": False,
                        "needs_approval": False,
                    },
                    ensure_ascii=False,
                )

            return json.dumps(
                {
                    "reply": (
                        "The homepage retest evidence is insufficient. I do not see enough Directorist layout/listing "
                        "signals or a concrete broken-layout signal in the current snapshot."
                    ),
                    "reasoning_summary": [
                        "The base Directorist activation action completed.",
                        "The homepage was opened and observed.",
                        "The snapshot does not prove fixed or still broken.",
                    ],
                    "questions": [
                        "Please provide a fuller homepage screenshot/snapshot or approve inspecting the page builder/widget configuration."
                    ],
                    "actions": [],
                    "done": False,
                    "needs_approval": True,
                },
                ensure_ascii=False,
            )

        return json.dumps(
            {
                "reply": (
                    "The base Directorist activation step completed and the homepage is now open. I will use this "
                    "snapshot as the retest evidence for the Directorist layout."
                ),
                "reasoning_summary": [
                    "The previous activation action completed successfully.",
                    "The current page is outside wp-admin, so it can be used for the homepage retest.",
                    "No further write action is needed for this verification step.",
                ],
                "questions": [],
                "actions": [
                    {
                        "type": "observe",
                        "target": "current-tab",
                        "reason": "Capture the homepage snapshot after Directorist activation.",
                    }
                ],
                "done": False,
                "needs_approval": False,
            },
            ensure_ascii=False,
        )

    return json.dumps(
        {
            "reply": "The base Directorist activation step completed. I will open the homepage now to retest the layout.",
            "reasoning_summary": [
                "The previous activation action completed successfully.",
                "Retesting the homepage is a read-only browser navigation.",
                "No plugin, setting, content, or file change is included in this step.",
            ],
            "questions": [],
            "actions": [
                {
                    "type": "navigate",
                    "target": homepage_url,
                    "value": homepage_url,
                    "reason": "Open the site homepage to verify the Directorist layout after activation.",
                }
            ],
            "done": False,
            "needs_approval": False,
        },
        ensure_ascii=False,
    )


def directorist_homepage_stronger_evidence_action(body: dict[str, Any]) -> dict[str, Any] | None:
    page = body.get("page") if isinstance(body.get("page"), dict) else {}
    homepage_url = homepage_url_from_page(page)
    if not homepage_url:
        return None

    host = urlparse(homepage_url).netloc
    return {
        "type": "tool",
        "tool": "chrome_cdp_check",
        "target": "chrome_cdp_check",
        "input": {
            "url_contains": host,
            "navigate_url": homepage_url,
            "viewport": {"width": 1440, "height": 900, "mobile": False, "device_scale_factor": 1},
            "selector": "body",
            "expect_visible": True,
            "capture_network": True,
            "screenshot": True,
            "screenshot_label": "directorist-homepage-retest",
        },
        "reason": "Collect a desktop homepage screenshot and DOM visibility check before deciding the retest result.",
    }


def homepage_stronger_evidence_requested(body: dict[str, Any]) -> bool:
    task_memory = body.get("task_memory") if isinstance(body.get("task_memory"), dict) else {}
    evidence = task_memory.get("evidence") if isinstance(task_memory.get("evidence"), list) else []
    for item in [*task_observations(body), *[entry for entry in evidence if isinstance(entry, dict)]]:
        compact = json.dumps(item, ensure_ascii=False).lower()
        if "chrome_cdp_check" in compact or "browser_verification" in compact:
            return True
        if "directorist-homepage-retest" in compact:
            return True
    return False


def directorist_homepage_retest_result(body: dict[str, Any]) -> str:
    page = body.get("page") if isinstance(body.get("page"), dict) else {}
    signals = merge_homepage_signals(
        [directorist_homepage_signals(page), *directorist_homepage_evidence_signals(body)]
    )
    if signals["broken"]:
        return json.dumps(
            {
                "reply": (
                    "The homepage retest still looks broken after the base Directorist activation. "
                    f"Evidence: {signals['broken'][0]}"
                ),
                "reasoning_summary": [
                    "The base Directorist activation action completed.",
                    *signals["broken"][:3],
                    "No additional plugin, setting, content, or file change was performed.",
                ],
                "questions": [
                    "Do you approve deeper inspection of the homepage builder/widget configuration and active plugin state?"
                ],
                "actions": [],
                "done": False,
                "needs_approval": True,
            },
            ensure_ascii=False,
        )

    if len(signals["healthy"]) >= 2:
        return json.dumps(
            {
                "reply": "The homepage retest looks fixed from the current snapshot. Directorist listing/filter content is visible without obvious layout-break signals.",
                "reasoning_summary": [
                    "The base Directorist activation action completed.",
                    *signals["healthy"][:3],
                    "No horizontal overflow or plugin dependency error was detected in the homepage snapshot.",
                ],
                "questions": [],
                "actions": [],
                "done": True,
                "needs_approval": False,
            },
            ensure_ascii=False,
        )

    return ""


def merge_homepage_signals(signal_sets: list[dict[str, list[str]]]) -> dict[str, list[str]]:
    merged = {"broken": [], "healthy": []}
    for signals in signal_sets:
        for bucket in ("broken", "healthy"):
            for item in signals.get(bucket, []):
                if item and item not in merged[bucket]:
                    merged[bucket].append(item)
    return merged


def directorist_homepage_evidence_signals(body: dict[str, Any]) -> list[dict[str, list[str]]]:
    signal_sets: list[dict[str, list[str]]] = []
    for item in homepage_cdp_evidence_items(body):
        if not is_homepage_cdp_observation(item):
            continue
        cdp_result = extract_chrome_cdp_result(item)
        if not cdp_result:
            continue

        assertion = cdp_result.get("assertion") if isinstance(cdp_result.get("assertion"), dict) else {}
        target = cdp_result.get("target") if isinstance(cdp_result.get("target"), dict) else {}
        evidence_page = {
            "url": target.get("url") or "",
            "visible_text": assertion.get("text") or "",
            "layout": assertion.get("layout") if isinstance(assertion.get("layout"), dict) else {},
            "clickables": assertion.get("clickables") if isinstance(assertion.get("clickables"), list) else [],
            "images": assertion.get("images") if isinstance(assertion.get("images"), list) else [],
        }
        signals = directorist_homepage_signals(evidence_page)
        if assertion and assertion.get("ok") is False:
            signals["broken"].append("Chrome CDP body visibility assertion failed during the homepage retest.")
        signal_sets.append(signals)

    return signal_sets


def homepage_cdp_evidence_items(body: dict[str, Any]) -> list[dict[str, Any]]:
    task_memory = body.get("task_memory") if isinstance(body.get("task_memory"), dict) else {}
    evidence = task_memory.get("evidence") if isinstance(task_memory.get("evidence"), list) else []
    return [
        *task_observations(body)[-8:],
        *[entry for entry in evidence[-10:] if isinstance(entry, dict)],
    ]


def is_homepage_cdp_observation(item: dict[str, Any]) -> bool:
    compact = json.dumps(item, ensure_ascii=False).lower()
    return (
        "chrome_cdp_check" in compact
        or "browser_verification" in compact
        or "directorist-homepage-retest" in compact
    )


def extract_chrome_cdp_result(value: Any, depth: int = 0) -> dict[str, Any] | None:
    if depth > 4 or not isinstance(value, dict):
        return None
    if isinstance(value.get("assertion"), dict):
        return value

    if value.get("tool") == "chrome_cdp_check" and isinstance(value.get("result"), dict):
        nested = extract_chrome_cdp_result(value["result"], depth + 1)
        if nested:
            return nested

    for key in ("result", "payload"):
        nested_value = value.get(key)
        if isinstance(nested_value, dict):
            nested = extract_chrome_cdp_result(nested_value, depth + 1)
            if nested:
                return nested

    return None


def directorist_homepage_signals(page: dict[str, Any]) -> dict[str, list[str]]:
    text = normalize_space(str(page.get("visible_text") or "")).lower()
    layout = page.get("layout") if isinstance(page.get("layout"), dict) else {}
    clickables = page.get("clickables") if isinstance(page.get("clickables"), list) else []
    images = page.get("images") if isinstance(page.get("images"), list) else []
    broken: list[str] = []
    healthy: list[str] = []

    if bool(layout.get("horizontal_overflow")):
        document_width = layout.get("document_width") or "unknown"
        viewport_width = layout.get("viewport_width") or "unknown"
        broken.append(f"Horizontal overflow remains: document width {document_width}px exceeds viewport {viewport_width}px.")

    dependency_needles = (
        "cannot be activated because required plugins are missing or inactive",
        "directorist - business directory solution activate",
        "directorist addonskit for elementor activate",
    )
    if any(needle in text for needle in dependency_needles):
        broken.append("The page still contains Directorist plugin dependency/activation text.")

    if "great things are coming soon" in text or "stay tuned" in text and "powered by godaddy" in text:
        broken.append("The homepage is still showing the host coming-soon page instead of the directory layout.")

    raw_filter_cluster = (
        text.count("more filters") >= 2
        and text.count("apply filters") >= 2
        and "reset filters" in text
    )
    if raw_filter_cluster:
        broken.append("The homepage still shows repeated raw filter controls, matching the broken unstyled layout pattern.")

    if any(needle in text for needle in ("items found", "performer/act name", "act directory", "filters")):
        healthy.append("Directorist listing/filter text is visible on the homepage.")

    if any(
        isinstance(item, dict) and any(token in str(item.get("text") or "").lower() for token in ("filters", "search", "reset filters"))
        for item in clickables
    ):
        healthy.append("Directory search/filter controls are present as clickable elements.")

    measurable_images = [
        item
        for item in images
        if isinstance(item, dict)
        and isinstance(item.get("box"), dict)
        and number_or_zero(item["box"].get("width")) > 20
        and number_or_zero(item["box"].get("height")) > 20
    ]
    if measurable_images:
        healthy.append("Visible image/card assets have measurable rendered sizes.")

    return {"broken": broken, "healthy": healthy}


def homepage_retest_observed(body: dict[str, Any]) -> bool:
    for item in task_observations(body)[-8:]:
        compact = json.dumps(item, ensure_ascii=False).lower()
        if "capture the homepage snapshot after directorist activation" in compact:
            return True
        if '"type": "observe"' in compact and ("homepage" in compact or "directorist" in compact):
            return True
    return False


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def number_or_zero(value: object) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0


def directorist_activation_completed(body: dict[str, Any]) -> bool:
    observations = task_observations(body)
    for item in observations[-8:]:
        if not isinstance(item, dict) or item.get("ok") is False:
            continue
        compact = json.dumps(item, ensure_ascii=False).lower()
        if "action=activate" not in compact and "activate the required base directorist" not in compact:
            continue
        if "directorist-addonskit" in compact or "addonskit" in compact:
            continue
        if "directorist%2fdirectorist-base.php" in compact or "directorist/directorist-base.php" in compact:
            return True
        if "ref_base_directorist" in compact or "base directorist plugin" in compact:
            return True
    return False


def task_observations(body: dict[str, Any]) -> list[dict[str, Any]]:
    task_state = body.get("task_state") if isinstance(body.get("task_state"), dict) else {}
    observations = task_state.get("observations") if isinstance(task_state.get("observations"), list) else []
    return [item for item in observations if isinstance(item, dict)]


def homepage_url_from_page(page: dict[str, Any]) -> str:
    current_url = str(page.get("url") or "")
    parsed = urlparse(current_url)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}/"


def is_same_url_without_path(left: str, right: str) -> bool:
    left_parsed = urlparse(str(left or ""))
    right_parsed = urlparse(str(right or ""))
    return (
        bool(left_parsed.scheme and left_parsed.netloc and right_parsed.scheme and right_parsed.netloc)
        and left_parsed.scheme.lower() == right_parsed.scheme.lower()
        and left_parsed.netloc.lower() == right_parsed.netloc.lower()
    )


def build_wordpress_plugin_dependency_reply(body: dict[str, Any]) -> str:
    context = support_context_text(body).lower()
    if "directorist" not in context:
        return ""

    dependency_problem = (
        "cannot be activated because" in context
        and ("required plugins are missing or inactive" in context or "required plugin" in context)
    )
    directorist_base_inactive = bool(
        re.search(
            r"directorist\s*-\s*business directory solution[\s\S]{0,260}\bactivate\b",
            context,
        )
    )
    addonskit_dependency = (
        "directorist addonskit" in context
        and ("requires:" in context or "required by:" in context or dependency_problem)
    )

    if not (dependency_problem and (directorist_base_inactive or addonskit_dependency)):
        return ""

    activation_action = directorist_base_activation_action(body)
    if activation_action and has_activation_approval(str(body.get("goal") or "")):
        return json.dumps(
            {
                "reply": (
                    "Approval received. I found the base Directorist activation target, so I will activate only that "
                    "required plugin and then the homepage should be retested."
                ),
                "reasoning_summary": [
                    "Runtime evidence is logged.",
                    "The current Plugins page shows the base Directorist plugin as the required inactive dependency.",
                    "The selected action targets the base Directorist plugin activation URL/ref, not AddonsKit or a generic Activate control.",
                    "No other plugin, setting, content, or file action is included.",
                ],
                "questions": [],
                "actions": [activation_action],
                "done": False,
                "needs_approval": False,
            },
            ensure_ascii=False,
        )

    return json.dumps(
        {
            "reply": (
                "The evidence points to a Directorist plugin dependency/state problem, not a CSS-only homepage issue. "
                "The base Directorist plugin appears inactive or missing, and the Directorist AddonsKit/Elementor "
                "dependency reports that required plugins are missing or inactive. The next safe step is to confirm "
                "plugin status and, only with approval, activate the required base Directorist plugin before retesting "
                "the homepage."
            ),
            "reasoning_summary": [
                "Runtime evidence is logged.",
                "Plugin-page evidence shows a Directorist dependency activation failure.",
                "The broken homepage/search layout is consistent with Directorist widgets rendering without the required base plugin active.",
                "No plugin activation, setting change, or file edit was performed.",
            ],
            "questions": [
                "Do you approve checking/activating the required Directorist plugin, then retesting the homepage layout?"
            ],
            "actions": [],
            "done": False,
            "needs_approval": True,
        },
        ensure_ascii=False,
    )


def directorist_base_activation_action(body: dict[str, Any]) -> dict[str, Any] | None:
    page = body.get("page") if isinstance(body.get("page"), dict) else {}
    clickables = page.get("clickables") if isinstance(page.get("clickables"), list) else []

    for item in clickables:
        if not isinstance(item, dict):
            continue
        href = str(item.get("href") or "").strip()
        text = str(item.get("text") or "").strip()
        decoded_href = safe_unquote(href).lower()
        text_lower = text.lower()

        if "action=activate" not in decoded_href:
            continue
        if not is_base_directorist_plugin_href(decoded_href):
            continue
        if "addonskit" in decoded_href or "addonskit" in text_lower:
            continue

        target = str(item.get("ref") or item.get("selector") or "").strip()
        if target:
            return {
                "type": "click",
                "target": target,
                "reason": "Activate the required base Directorist plugin from its exact Plugins-page control.",
            }
        if href.startswith(("http://", "https://")):
            return {
                "type": "navigate",
                "target": href,
                "value": href,
                "reason": "Open the exact nonce-protected base Directorist activation URL.",
            }

    return None


def is_base_directorist_plugin_href(decoded_href: str) -> bool:
    plugin_match = re.search(r"[?&]plugin=([^&#]+)", decoded_href)
    plugin_value = plugin_match.group(1) if plugin_match else decoded_href
    return (
        plugin_value.startswith("directorist/")
        or plugin_value.startswith("directorist%2f")
        or "directorist-base" in plugin_value
    )


def has_activation_approval(goal: str) -> bool:
    return bool(
        re.search(r"\b(yes|yeah|yep|approve|approved|confirm|confirmed|proceed|go ahead|allow|ok|okay|hmm|ha|haan)\b", goal.lower())
    )


def safe_unquote(value: str) -> str:
    try:
        from urllib.parse import unquote

        return unquote(value)
    except Exception:
        return value


def support_context_text(body: dict[str, Any]) -> str:
    page = body.get("page") if isinstance(body.get("page"), dict) else {}
    task_memory = body.get("task_memory") if isinstance(body.get("task_memory"), dict) else {}
    conversation_memory = body.get("conversation_memory") if isinstance(body.get("conversation_memory"), dict) else {}
    evidence = task_memory.get("evidence") if isinstance(task_memory.get("evidence"), list) else []
    parts: list[str] = [
        str(body.get("goal") or ""),
        str(page.get("url") or ""),
        str(page.get("title") or ""),
        str(page.get("visible_text") or ""),
        str(page.get("accessibility_tree") or ""),
        str(conversation_memory.get("summary") or ""),
        json.dumps(conversation_memory.get("last_task") or {}, ensure_ascii=False),
    ]
    for item in evidence[-8:]:
        if not isinstance(item, dict):
            continue
        for key in ("type", "title", "summary", "message", "path"):
            value = item.get(key)
            if value:
                parts.append(str(value))
        result = item.get("result")
        if isinstance(result, dict):
            for key in ("summary", "active_theme", "directorist_plugins", "plugins"):
                value = result.get(key)
                if value:
                    parts.append(json.dumps(value, ensure_ascii=False))
    return " ".join(parts)


def build_auth_blocker_reply(body: dict[str, Any]) -> str:
    goal = str(body.get("goal") or "")
    page = body.get("page") if isinstance(body.get("page"), dict) else {}
    page_url = str(page.get("url") or "")
    page_title = str(page.get("title") or "")
    page_text = " ".join(
        str(page.get(key) or "")
        for key in ("title", "visible_text", "accessibility_tree")
    ).lower()
    context = f"{goal} {page_url} {page_title} {page_text}".lower()

    is_godaddy_sso = "sso.godaddy.com" in page_url.lower() or (
        "godaddy" in context and "sign in" in page_text and "wp-admin" in context
    )
    is_wordpress_admin_goal = any(token in context for token in ("wp-admin", "wp-login", "wordpress", "dashboard"))
    if not is_godaddy_sso or not is_wordpress_admin_goal:
        return ""

    return json.dumps(
        {
            "reply": (
                "Admin access is blocked by the GoDaddy SSO screen. I cannot continue the WordPress dashboard "
                "investigation with only the standard WordPress credentials from this page."
            ),
            "reasoning_summary": [
                "Runtime evidence is logged.",
                "The current page is GoDaddy SSO, not the WordPress dashboard.",
                "No site settings or content were changed.",
            ],
            "questions": [
                "Please provide GoDaddy SSO access or a WordPress login URL/account that bypasses the GoDaddy SSO gate."
            ],
            "actions": [],
            "done": False,
            "needs_approval": True,
        },
        ensure_ascii=False,
    )


def build_wordpress_login_continuation(body: dict[str, Any]) -> str:
    goal = str(body.get("goal") or "")
    username, password = extract_supplied_credentials(goal)
    admin_url = extract_admin_url(goal)

    page = body.get("page") if isinstance(body.get("page"), dict) else {}
    page_url = str(page.get("url") or "")
    page_text = " ".join(
        str(page.get(key) or "")
        for key in ("title", "visible_text", "accessibility_tree")
    ).lower()
    forms = page.get("forms") if isinstance(page.get("forms"), list) else []
    fields_text = json.dumps(forms, ensure_ascii=False).lower()

    approved_login_target = approved_wordpress_login_click_target(goal, page, page_text)
    if approved_login_target:
        return json.dumps(
            {
                "reply": "Approved login entry is clear. I will click the WordPress Log In button and continue read-only investigation.",
                "reasoning_summary": [
                    "Runtime evidence is logged.",
                    "The current page is a WordPress login screen.",
                    "The user explicitly approved entering the dashboard for read-only investigation.",
                ],
                "questions": [],
                "actions": [
                    {
                        "type": "click",
                        "target": approved_login_target,
                        "reason": "Enter the WordPress dashboard after explicit approval.",
                    }
                ],
                "done": False,
                "needs_approval": False,
            },
            ensure_ascii=False,
        )

    if not username or not password:
        return ""

    if "log in with username and password" in page_text:
        return json.dumps(
            {
                "reply": "I found the alternate WordPress username/password login option. I will open that form next.",
                "reasoning_summary": [
                    "Runtime evidence is logged.",
                    "The current login page exposes a username/password login option.",
                    "The user supplied credentials in the task prompt.",
                ],
                "questions": [],
                "actions": [
                    {
                        "type": "click",
                        "target": "text=Log in with username and password",
                        "reason": "Open the standard WordPress username/password login form.",
                    }
                ],
                "done": False,
                "needs_approval": False,
            },
            ensure_ascii=False,
        )

    has_username_field = any(token in fields_text or token in page_text for token in (
        "user_login",
        'name="log"',
        '"name": "log"',
        "input[name=\\\"log\\\"]",
        "username",
    ))
    has_password_field = any(token in fields_text or token in page_text for token in (
        "user_pass",
        'name="pwd"',
        '"name": "pwd"',
        "input[name=\\\"pwd\\\"]",
        "password",
    ))
    if has_username_field and has_password_field:
        return json.dumps(
            {
                "reply": "I found the WordPress username/password fields. I will submit the supplied credentials and then inspect the issue flow.",
                "reasoning_summary": [
                    "Runtime evidence is logged.",
                    "The current page has username and password fields.",
                    "No settings or files will be changed during login.",
                ],
                "questions": [],
                "actions": [
                    {
                        "type": "type",
                        "target": "input[name=\"log\"]",
                        "value": username,
                        "reason": "Fill the supplied WordPress username.",
                    },
                    {
                        "type": "type",
                        "target": "input[name=\"pwd\"]",
                        "value": password,
                        "reason": "Fill the supplied WordPress password.",
                    },
                    {
                        "type": "click",
                        "target": "#wp-submit",
                        "reason": "Submit the WordPress login form.",
                    },
                ],
                "done": False,
                "needs_approval": False,
            },
            ensure_ascii=False,
        )

    if admin_url and page_url and page_url.rstrip("/") != admin_url.rstrip("/") and "/wp-admin" not in page_url:
        return json.dumps(
            {
                "reply": "I have the supplied WordPress admin URL. I will open it before collecting more evidence.",
                "reasoning_summary": [
                    "Runtime evidence is logged.",
                    "The task prompt includes a concrete WordPress admin URL.",
                    "Opening the admin URL is a safe navigation step.",
                ],
                "questions": [],
                "actions": [
                    {
                        "type": "navigate",
                        "target": admin_url,
                        "value": admin_url,
                        "reason": "Open the supplied WordPress admin URL.",
                    }
                ],
                "done": False,
                "needs_approval": False,
            },
            ensure_ascii=False,
        )

    return ""


def approved_wordpress_login_click_target(goal: str, page: dict[str, Any], page_text: str) -> str:
    lower_goal = goal.lower()
    if not re.search(r"\b(approve|approved|confirm|confirmed|proceed|go ahead|allow|ok|okay|hmm|ha|haan)\b", lower_goal):
        return ""

    if not re.search(r"\b(log in|login|wp-submit|dashboard|wp-admin)\b", lower_goal):
        return ""

    risk_goal = re.sub(r"\b(?:do not|don't|dont|never)\b[^.?!]*", "", lower_goal)
    if re.search(r"\b(delete|remove|publish|payment|pay|checkout|purchase|merge|deploy|reset|destroy|drop|truncate)\b", risk_goal):
        return ""

    page_url = str(page.get("url") or "").lower()
    page_title = str(page.get("title") or "").lower()
    clickables = page.get("clickables") if isinstance(page.get("clickables"), list) else []
    has_login_page_signal = (
        "wp-login.php" in page_url
        or "log in" in page_title
        or "wordpress" in page_title
        or "log in" in page_text
    )
    if not has_login_page_signal:
        return ""

    for item in clickables:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").lower()
        if "log in" in text:
            target = str(item.get("ref") or item.get("selector") or "").strip()
            if target:
                return target

    return "#wp-submit" if "wp-login.php" in page_url or "log in" in page_text else ""


def extract_admin_url(text: str) -> str:
    match = re.search(r"https?://[^\s)>\"]+/wp-admin/?", text, flags=re.IGNORECASE)
    return match.group(0) if match else ""


def extract_supplied_credentials(text: str) -> tuple[str, str]:
    username_match = re.search(r"(?:user(?:name)?|login)\s*:\s*([^\s\r\n]+)", text, flags=re.IGNORECASE)
    password_match = re.search(r"(?:pw|pass(?:word)?)\s*:\s*([^\r\n]+)", text, flags=re.IGNORECASE)
    username = username_match.group(1).strip() if username_match else ""
    password = password_match.group(1).strip() if password_match else ""
    return username, password


def normalize_agent_contract_json(raw: str) -> str:
    """Normalize a provider JSON string to the sidebar's required contract."""

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = {"reply": str(raw or "")}

    if not isinstance(parsed, dict):
        parsed = {"reply": str(raw or "")}

    normalized = normalize_agent_contract(parsed)
    return json.dumps(normalized, ensure_ascii=False)


def normalize_agent_contract(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(AGENT_CONTRACT_DEFAULT)
    normalized["reply"] = str(payload.get("reply") or "")
    normalized["reasoning_summary"] = normalize_string_list(payload.get("reasoning_summary"))
    normalized["questions"] = normalize_string_list(payload.get("questions"))
    normalized["actions"] = normalize_actions(payload.get("actions"))
    normalized["done"] = bool(payload.get("done"))
    normalized["needs_approval"] = bool(payload.get("needs_approval"))
    return normalized


def normalize_string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item or "").strip()]


def normalize_actions(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []

    actions: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        action = {
            "type": str(item.get("type") or ""),
            "target": str(item.get("target") or item.get("url") or ""),
            "value": str(item.get("value") or item.get("text") or ""),
            "reason": str(item.get("reason") or ""),
        }
        if item.get("tool"):
            action["tool"] = str(item.get("tool"))
        if isinstance(item.get("input"), dict):
            action["input"] = item["input"]
        if item.get("mode"):
            action["mode"] = str(item.get("mode"))
        actions.append(action)
    return actions[:3]
