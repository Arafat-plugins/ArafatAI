"""Small deterministic browser planner for high-confidence safe actions.

This is not the main AI brain. It is a fast local fallback so the browser
sidebar can keep working when the temporary Codex provider is unavailable or
slow. Every reasoning line produced here is derived from the supplied goal and
page snapshot.
"""

from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, quote_plus, unquote_plus, urlparse


SAFE_MODES = {"browser_plan", "agent_chat", "agent_plan", "agent_task"}
RISKY_RE = re.compile(
    r"\b(delete|remove|publish|payment|pay|checkout|purchase|merge|deploy|reset|destroy|"
    r"password|otp|2fa|bank|card|withdraw|transfer|submit|post)\b",
    re.IGNORECASE,
)
GREET_RE = re.compile(r"^\s*(hi|hello|hey|salam|assalamu|assalamu alaikum)\s*[!.।]*\s*$", re.IGNORECASE)
DOMAIN_RE = re.compile(r"\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:/[^\s]*)?", re.IGNORECASE)
STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "ache",
    "amar",
    "ami",
    "akta",
    "ekta",
    "e",
    "er",
    "the",
    "to",
    "te",
    "ta",
    "theke",
    "from",
    "for",
    "dao",
    "daw",
    "de",
    "dekhao",
    "dekhaw",
    "dekhte",
    "dia",
    "diye",
    "koro",
    "kor",
    "kore",
    "korte",
    "jai",
    "jao",
    "open",
    "go",
    "search",
    "google",
    "image",
    "images",
    "img",
    "video",
    "videos",
    "play",
    "current",
    "page",
    "url",
    "ekhane",
    "jekono",
    "kon",
    "konta",
    "please",
    "pls",
}


def build_local_agent_reply(body: dict[str, object], *, allow_question_fallback: bool = True) -> str | None:
    """Return strict JSON for safe obvious browser intents.

    When ``allow_question_fallback`` is false, unknown complex goals return
    ``None`` so the LLM provider can try first.
    """

    mode = str(body.get("mode") or "chat")
    if mode not in SAFE_MODES:
        return None

    goal = _normalize(str(body.get("goal") or body.get("message") or ""))
    page = body.get("page") if isinstance(body.get("page"), dict) else {}
    task_state = body.get("task_state") if isinstance(body.get("task_state"), dict) else {}
    if not goal:
        return _dump(
            reply="What should I do on this page?",
            reasoning_summary=["No user goal was supplied."],
            questions=["What task should I run?"],
            actions=[],
            done=False,
            needs_approval=True,
        )

    if GREET_RE.match(goal):
        return _dump(
            reply="Hi. How can I help?",
            reasoning_summary=["The message is a greeting, so no browser action is needed."],
            questions=[],
            actions=[],
            done=True,
            needs_approval=False,
        )

    if RISKY_RE.search(goal):
        return _dump(
            reply="This may affect an account, content, payment, or settings. I need your exact approval before acting.",
            reasoning_summary=["The request contains a risky action keyword, so local automation is blocked."],
            questions=["Do you want me to proceed with this risky action?"],
            actions=[],
            done=False,
            needs_approval=True,
        )

    read_only_reply = _read_only_reply(goal, page)
    if read_only_reply:
        return read_only_reply

    completion_reply = _completion_plan(goal, page)
    if completion_reply:
        return completion_reply

    demo_action = _demo_plan(goal, page)
    if demo_action:
        return _dump(
            reply="Testing mode e safe demo action dicchi.",
            reasoning_summary=[
                _page_evidence(page),
                demo_action.pop("_reasoning"),
                "Demo action is non-destructive and does not submit forms.",
            ],
            questions=[],
            actions=[demo_action],
            done=False,
            needs_approval=False,
        )

    youtube_action = _youtube_plan(goal, page)
    if youtube_action:
        return _dump(
            reply="I found the next safe YouTube step.",
            reasoning_summary=[
                _page_evidence(page),
                youtube_action.pop("_reasoning"),
                "This is a safe navigation/click action, not a form submission or destructive change.",
            ],
            questions=[],
            actions=[youtube_action],
            done=False,
            needs_approval=False,
        )

    search_action = _search_plan(goal)
    if search_action:
        return _dump(
            reply="I can run that search now.",
            reasoning_summary=[
                _page_evidence(page),
                search_action.pop("_reasoning"),
                "Search/navigation is a safe browser action.",
            ],
            questions=[],
            actions=[search_action],
            done=False,
            needs_approval=False,
        )

    nav_action = _navigation_plan(goal)
    if nav_action:
        return _dump(
            reply="I can open that page now.",
            reasoning_summary=[
                _page_evidence(page),
                nav_action.pop("_reasoning"),
                "Opening a URL is safe and reversible.",
            ],
            questions=[],
            actions=[nav_action],
            done=False,
            needs_approval=False,
        )

    theme_wait_action = _theme_wait_plan(goal, page, task_state)
    if theme_wait_action:
        return _dump(
            reply="Themes page open ache, theme list load/visible howar jonno wait kore abar check korchi.",
            reasoning_summary=[
                _page_evidence(page),
                theme_wait_action.pop("_reasoning"),
                "The task is not complete yet, so the loop should continue.",
            ],
            questions=[],
            actions=[theme_wait_action],
            done=False,
            needs_approval=False,
        )

    click_action = _click_plan(goal, page)
    if click_action:
        return _dump(
            reply="I found a matching page control.",
            reasoning_summary=[
                _page_evidence(page),
                click_action.pop("_reasoning"),
                "The target came from the current page snapshot.",
            ],
            questions=[],
            actions=[click_action],
            done=False,
            needs_approval=False,
        )

    if not allow_question_fallback:
        return None

    return _dump(
        reply="I need one more detail before acting.",
        reasoning_summary=[
            _page_evidence(page),
            "The local planner could not map this goal to one safe, obvious browser action.",
        ],
        questions=["What exact page, search topic, button text, or URL should I use?"],
        actions=[],
        done=False,
        needs_approval=True,
    )


def _read_only_reply(goal: str, page: dict[str, object]) -> str | None:
    meta_reply = _meta_question_reply(goal, page)
    if meta_reply:
        return meta_reply

    theme_reply = _theme_list_reply(goal, page)
    if theme_reply:
        return theme_reply

    if _has_explicit_action_intent(goal):
        return None

    pricing_reply = _pricing_reply(goal, page)
    if pricing_reply:
        return pricing_reply

    current_site_reply = _current_site_reply(goal, page)
    if current_site_reply:
        return current_site_reply

    return None


def _meta_question_reply(goal: str, page: dict[str, object]) -> str | None:
    lower = goal.lower()
    asks_fast_answer = (
        ("fast" in lower or "taratari" in lower or "quick" in lower)
        and re.search(r"\b(ans|answer|reply|diccho|diteso|dile|daw|dao)\b", lower)
    )
    asks_how_it_works = (
        "kivabe" in lower
        and re.search(r"\b(ans|answer|reply|kaj|work|korcho|diccho|diteso)\b", lower)
    )
    if not asks_fast_answer and not asks_how_it_works:
        return None

    return _dump(
        reply=(
            "Fast answer dicchi karon eta simple/local route e solve hocche. "
            "Greeting, current page info, obvious safe click/search, ba visible page snapshot theke list/price "
            "local planner direct answer kore. Complex/unclear task hole then Codex/AI planner e jay, tai wait hote pare."
        ),
        reasoning_summary=[
            _page_evidence(page),
            "The user asked how the sidebar answered quickly, so this is a conversational explanation.",
            "No browser action is needed for this question.",
        ],
        questions=[],
        actions=[],
        done=True,
        needs_approval=False,
    )


def _current_site_reply(goal: str, page: dict[str, object]) -> str | None:
    lower = goal.lower()
    asks_current_site = (
        "kon site" in lower
        or "which site" in lower
        or "what site" in lower
        or "current site" in lower
        or "current page" in lower
        or "kothay acho" in lower
        or "kothai acho" in lower
        or "where am i" in lower
        or "where are you" in lower
    )
    if not asks_current_site:
        return None

    url = str(page.get("url") or "").strip()
    title = str(page.get("title") or "").strip()
    if not url:
        return _dump(
            reply="Current tab er URL snapshot e paini.",
            reasoning_summary=["The user asked which site is open, but no page URL was supplied."],
            questions=["Which tab or URL should I inspect?"],
            actions=[],
            done=False,
            needs_approval=True,
        )

    parsed = urlparse(url)
    host = parsed.netloc or url
    reply = f"Haan, ekhon {host} site e achi."
    if title:
        reply += f"\nPage: {title}"
    reply += f"\nURL: {url}"

    return _dump(
        reply=reply,
        reasoning_summary=[
            _page_evidence(page),
            "The user asked for the current site/page, so no browser action is needed.",
        ],
        questions=[],
        actions=[],
        done=True,
        needs_approval=False,
    )


def _pricing_reply(goal: str, page: dict[str, object]) -> str | None:
    lower = goal.lower()
    asks_pricing = re.search(r"\b(price|pricing|plan|plans|dam|taka|koto)\b", lower)
    if not asks_pricing:
        return None

    visible_text = _normalize(str(page.get("visible_text") or ""))
    if "$" not in visible_text:
        return None

    plans = _pricing_plans_from_text(visible_text)
    if not plans:
        return None

    lines = ["Current page snapshot theke pricing list:"]
    for plan in plans[:6]:
        label = str(plan["name"])
        if plan.get("sites"):
            label += f" ({plan['sites']})"

        price = str(plan["price"])
        term = str(plan.get("term") or "").lower()
        if term:
            price += f"/{term}"

        details = [price]
        if plan.get("regular"):
            details.append(f"regular {plan['regular']}")
        if plan.get("save"):
            details.append(f"save {plan['save']}")
        if plan.get("renewal"):
            details.append(f"renews {plan['renewal']}/yr")

        lines.append(f"- {label}: {', '.join(details)}")

    return _dump(
        reply="\n".join(lines),
        reasoning_summary=[
            _page_evidence(page),
            f"Found {len(plans)} pricing item(s) in the current page visible text.",
            "This is a read-only answer, so no browser action is needed.",
        ],
        questions=[],
        actions=[],
        done=True,
        needs_approval=False,
    )


def _pricing_plans_from_text(text: str) -> list[dict[str, str]]:
    plans: list[dict[str, str]] = []
    plan_pattern = re.compile(
        r"(?:(?:Most Popular)\s+)?"
        r"(?P<sites>(?:\d+\s+Sites?|Unlimited Sites?))\s+"
        r"(?P<name>Starter|Agency|Pro)\s+"
        r".*?"
        r"(?P<regular>\$\d[\d,]*)\s+Save\s+(?P<save>\d+%)\s+"
        r"(?P<price>\$\d[\d,]*)\s*/(?P<term>Year|Month)"
        r"(?:\s+Renews at\s+(?P<renewal>\$\d[\d,]*)/yr)?",
        re.IGNORECASE,
    )
    for match in plan_pattern.finditer(text):
        plans.append(
            {
                "name": match.group("name"),
                "sites": match.group("sites"),
                "regular": match.group("regular"),
                "save": match.group("save"),
                "price": match.group("price"),
                "term": match.group("term"),
                "renewal": match.group("renewal") or "",
            }
        )

    bundle = re.search(
        r"Own It Forever\s+Mega Bundle\b.*?Pay\s+(?P<price>\$\d[\d,]*)\s*/(?P<term>Once)"
        r"\s+(?P<regular>\$\d[\d,]*)\s+separately",
        text,
        re.IGNORECASE,
    )
    if bundle:
        plans.append(
            {
                "name": "Mega Bundle",
                "sites": "",
                "regular": bundle.group("regular"),
                "save": "",
                "price": bundle.group("price"),
                "term": bundle.group("term"),
                "renewal": "",
            }
        )

    return plans


def _theme_list_reply(goal: str, page: dict[str, object]) -> str | None:
    lower = goal.lower()
    if not _is_theme_list_goal(goal):
        return None

    url = str(page.get("url") or "")
    title = str(page.get("title") or "")
    visible_text = _normalize(str(page.get("visible_text") or ""))
    is_theme_page = "themes" in urlparse(url).path.lower() or "theme" in title.lower()
    if not is_theme_page:
        return None

    themes = _theme_items_from_page(page, visible_text)
    if not themes:
        return None

    lines = ["Current themes page theke theme list:"]
    for item in themes[:12]:
        price = f" - {item['price']}" if item.get("price") else ""
        lines.append(f"- {item['name']}{price}")

    return _dump(
        reply="\n".join(lines),
        reasoning_summary=[
            _page_evidence(page),
            f"Found {len(themes)} theme item(s) from the current themes page snapshot.",
            "This answers after the requested Themes page is open, so no extra browser action is needed.",
        ],
        questions=[],
        actions=[],
        done=True,
        needs_approval=False,
    )


def _theme_wait_plan(goal: str, page: dict[str, object], task_state: dict[str, object]) -> dict[str, object] | None:
    if not _is_theme_list_goal(goal):
        return None

    url = str(page.get("url") or "")
    title = str(page.get("title") or "")
    visible_text = _normalize(str(page.get("visible_text") or ""))
    is_theme_page = "themes" in urlparse(url).path.lower() or "theme" in title.lower()
    if not is_theme_page:
        return None

    if _theme_items_from_page(page, visible_text):
        return None

    observations = task_state.get("observations") if isinstance(task_state.get("observations"), list) else []
    recent_waits = sum(
        1
        for item in observations[-4:]
        if isinstance(item, dict) and "waited" in str(item.get("message") or "").lower()
    )
    wait_ms = 1200 if recent_waits < 2 else 2000
    return {
        "type": "wait",
        "target": "theme-list",
        "value": wait_ms,
        "reason": "Wait for the themes list/cards to finish loading before answering.",
        "_reasoning": "The current page is the Themes page, but the snapshot does not yet expose theme list items.",
    }


def _is_theme_list_goal(goal: str) -> bool:
    lower = goal.lower()
    return "theme" in lower and bool(re.search(r"\b(list|show|dao|daw|dekhaw|dekhao)\b", lower))


def _theme_items_from_page(page: dict[str, object], visible_text: str) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    seen: set[str] = set()

    clickables = page.get("clickables") if isinstance(page.get("clickables"), list) else []
    for clickable in clickables:
        if not isinstance(clickable, dict):
            continue
        href = str(clickable.get("href") or "").lower()
        text = _normalize(str(clickable.get("text") or ""))
        if "/themes/" not in href or not text:
            continue
        candidate = _theme_name_from_text(text)
        if candidate and candidate.lower() not in seen:
            seen.add(candidate.lower())
            items.append({"name": candidate, "price": ""})

    theme_pattern = re.compile(
        r"\b(?P<name>OneListing(?:\s+Pro)?|d[A-Z][A-Za-z]+)\s+"
        r"(?:(?:New|Trending)\s+)?"
        r"(?:(?P<price>\$\d[\d,]*)\s+)?"
        r"(?P<desc>[^$]{0,140}?Theme[^$]{0,100}?)(?=\s+Live Preview|\s+Details)",
    )
    for match in theme_pattern.finditer(visible_text):
        name = _normalize(match.group("name"))
        if not name or name.lower() in seen:
            continue
        desc = match.group("desc") or ""
        price = match.group("price") or ("Free" if "free" in desc.lower() else "")
        seen.add(name.lower())
        items.append({"name": name, "price": price})

    return items


def _theme_name_from_text(text: str) -> str:
    match = re.search(r"\b(OneListing(?:\s+Pro)?|d[A-Z][A-Za-z]+)\b", text)
    return match.group(1) if match else ""


def _completion_plan(goal: str, page: dict[str, object]) -> str | None:
    current_url = str(page.get("url") or "")
    parsed = urlparse(current_url)
    host = parsed.netloc.lower()
    lower = goal.lower()

    if "youtube" in lower and "youtube.com" in host:
        query = _extract_query(goal, extra_stop={"youtube"})
        if "play" in lower and "/watch" in parsed.path:
            return _done_reply(page, "The current page is already a YouTube watch page.")
        if query:
            params = parse_qs(parsed.query)
            current_query = _normalize(unquote_plus(" ".join(params.get("search_query", [])))).lower()
            if "results" in parsed.path and _normalize(query).lower() in current_query:
                return _done_reply(page, f'The current YouTube results page already matches "{query}".')
        elif parsed.path in {"", "/"}:
            return _done_reply(page, "The current page is already the YouTube homepage.")

    if _is_demo_goal(goal) and host == "example.com":
        return _done_reply(page, "The safe demo page is already open, so no extra click is needed.")

    if ("search" in lower or "google" in lower or "image" in lower or "images" in lower) and "google." in host:
        query = _extract_query(goal)
        params = parse_qs(parsed.query)
        current_query = _normalize(unquote_plus(" ".join(params.get("q", [])))).lower()
        wants_image = "image" in lower or "images" in lower or "img" in lower
        is_image_page = params.get("tbm", [""])[0] == "isch"
        if query and _normalize(query).lower() in current_query and (not wants_image or is_image_page):
            return _done_reply(page, f'The current Google {"Images " if wants_image else ""}results already match "{query}".')

    nav_action = _navigation_plan(goal)
    if nav_action:
        target_host = urlparse(str(nav_action.get("target") or "")).netloc.lower()
        if target_host and host == target_host:
            return _done_reply(page, f"The current page is already on {target_host}.")

    return None


def _demo_plan(goal: str, page: dict[str, object]) -> dict[str, object] | None:
    if not _is_demo_goal(goal):
        return None

    return {
        "type": "navigate",
        "target": "https://example.com/",
        "value": "https://example.com/",
        "reason": "Open a safe demo page.",
        "_reasoning": "The goal asks for a testing/demo action, so opening example.com is enough proof without risky clicks.",
    }


def _is_demo_goal(goal: str) -> bool:
    lower = goal.lower()
    return (
        "testing mode" in lower
        or "test mode" in lower
        or "demo" in lower
        or "kichu kore dekhao" in lower
        or "kisu kore dekhao" in lower
        or "ekta kichu kore dekhao" in lower
    )


def _done_reply(page: dict[str, object], reason: str) -> str:
    return _dump(
        reply="Done.",
        reasoning_summary=[_page_evidence(page), reason],
        questions=[],
        actions=[],
        done=True,
        needs_approval=False,
    )


def _youtube_plan(goal: str, page: dict[str, object]) -> dict[str, object] | None:
    lower = goal.lower()
    current_url = str(page.get("url") or "")

    if "youtube" in lower and re.search(r"\b(jao|go|open|open koro|navigate)\b", lower):
        query = _extract_query(goal, extra_stop={"youtube"})
        if not query:
            return {
                "type": "navigate",
                "target": "https://www.youtube.com/",
                "value": "https://www.youtube.com/",
                "reason": "Open YouTube homepage.",
                "_reasoning": "The goal asks to go to YouTube and no search query was provided.",
            }
        return {
            "type": "navigate",
            "target": _youtube_search_url(query),
            "value": _youtube_search_url(query),
            "reason": f"Open YouTube results for {query}.",
            "_reasoning": f'The goal names YouTube with query "{query}".',
        }

    if "youtube.com" in current_url and re.search(r"\b(video|play|search|course)\b", lower):
        video = _first_youtube_video(page)
        if video and "play" in lower:
            return {
                "type": "click",
                "target": video["target"],
                "value": "",
                "reason": "Play the first visible YouTube video result.",
                "_reasoning": "The current YouTube snapshot contains a visible watch link.",
            }

        query = _extract_query(goal, extra_stop={"youtube"})
        if query:
            return {
                "type": "navigate",
                "target": _youtube_search_url(query),
                "value": _youtube_search_url(query),
                "reason": f"Search YouTube for {query}.",
                "_reasoning": f'The current page is YouTube and the extracted video query is "{query}".',
            }

    return None


def _search_plan(goal: str) -> dict[str, object] | None:
    lower = goal.lower()
    wants_search = "search" in lower or "google" in lower or "khoj" in lower
    wants_image = "image" in lower or "images" in lower or "img" in lower
    if not wants_search and not wants_image:
        return None

    query = _extract_query(goal)
    if not query:
        return None

    return {
        "type": "search",
        "target": query,
        "value": query,
        "mode": "images" if wants_image else "web",
        "reason": f"Search for {query}.",
        "_reasoning": f'The goal is a {"Google Images" if wants_image else "Google"} search and the extracted query is "{query}".',
    }


def _navigation_plan(goal: str) -> dict[str, object] | None:
    lower = goal.lower()
    if not re.search(r"\b(open|go|jao|navigate)\b", lower):
        return None

    match = DOMAIN_RE.search(goal)
    if not match:
        return None

    raw = match.group(0).strip().rstrip(".,)")
    url = raw if re.match(r"^https?://", raw, re.IGNORECASE) else f"https://{raw}"
    return {
        "type": "navigate",
        "target": url,
        "value": url,
        "reason": f"Open {url}.",
        "_reasoning": f'The goal contains a URL/domain "{raw}".',
    }


def _click_plan(goal: str, page: dict[str, object]) -> dict[str, object] | None:
    lower = goal.lower()
    if not re.search(r"\b(click|open|press|tap|play)\b", lower):
        return None

    clickables = page.get("clickables") if isinstance(page.get("clickables"), list) else []
    terms = [word for word in _words(goal) if word not in STOP_WORDS and len(word) > 2]
    if not terms:
        return None

    best: dict[str, object] | None = None
    best_score = 0
    for item in clickables:
        if not isinstance(item, dict):
            continue
        text = _normalize(str(item.get("text") or item.get("href") or ""))
        if not text:
            continue
        score = sum(1 for term in terms if term in text.lower())
        if score > best_score:
            best = item
            best_score = score

    if not best or best_score == 0:
        return None

    target = str(best.get("ref") or best.get("selector") or "")
    label = _normalize(str(best.get("text") or best.get("href") or target))
    if not target:
        return None

    href = str(best.get("href") or "").strip()
    if href and re.match(r"^https?://", href, re.IGNORECASE):
        current_url = str(page.get("url") or "")
        if _same_url_without_hash(href, current_url):
            return None
        return {
            "type": "navigate",
            "target": href,
            "value": href,
            "reason": f"Open visible page link: {label[:80]}.",
            "_reasoning": f'The page snapshot has a matching link "{label[:80]}" with URL {href}.',
        }

    return {
        "type": "click",
        "target": target,
        "value": "",
        "reason": f"Click visible page control: {label[:80]}.",
        "_reasoning": f'The page snapshot has a clickable target matching {best_score} goal word(s): "{label[:80]}".',
    }


def _has_explicit_action_intent(goal: str) -> bool:
    return bool(re.search(r"\b(click|open|press|tap|tab|jao|go|navigate)\b", goal.lower()))


def _same_url_without_hash(left: str, right: str) -> bool:
    try:
        left_url = urlparse(left)
        right_url = urlparse(right)
    except ValueError:
        return left == right

    return (
        left_url.scheme,
        left_url.netloc,
        left_url.path.rstrip("/"),
        left_url.query,
    ) == (
        right_url.scheme,
        right_url.netloc,
        right_url.path.rstrip("/"),
        right_url.query,
    )


def _first_youtube_video(page: dict[str, object]) -> dict[str, str] | None:
    clickables = page.get("clickables") if isinstance(page.get("clickables"), list) else []
    for item in clickables:
        if not isinstance(item, dict):
            continue
        href = str(item.get("href") or "")
        text = _normalize(str(item.get("text") or ""))
        if "/watch" not in href or not text:
            continue
        target = str(item.get("ref") or item.get("selector") or "")
        if target:
            return {"target": target, "text": text}
    return None


def _extract_query(goal: str, *, extra_stop: set[str] | None = None) -> str:
    stop_words = STOP_WORDS | (extra_stop or set())
    words = [word for word in _words(goal) if word not in stop_words]
    return " ".join(words[:12]).strip()


def _youtube_search_url(query: str) -> str:
    return f"https://www.youtube.com/results?search_query={quote_plus(query)}"


def _words(text: str) -> list[str]:
    return [word.lower() for word in re.findall(r"[a-z0-9+#.]+", text, re.IGNORECASE)]


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _page_evidence(page: dict[str, object]) -> str:
    url = str(page.get("url") or "").strip()
    title = str(page.get("title") or "").strip()
    if url:
        parsed = urlparse(url)
        host = parsed.netloc or url
        return f'Current page snapshot is "{title or host}" at {host}.'
    return "No inspectable page URL was supplied, so only the user goal was used."


def _dump(
    *,
    reply: str,
    reasoning_summary: list[str],
    questions: list[str],
    actions: list[dict[str, object]],
    done: bool,
    needs_approval: bool,
) -> str:
    return json.dumps(
        {
            "reply": reply,
            "reasoning_summary": reasoning_summary,
            "questions": questions,
            "actions": actions,
            "done": done,
            "needs_approval": needs_approval,
        },
        ensure_ascii=False,
    )
