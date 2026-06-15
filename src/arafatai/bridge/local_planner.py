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

    return {
        "type": "click",
        "target": target,
        "value": "",
        "reason": f"Click visible page control: {label[:80]}.",
        "_reasoning": f'The page snapshot has a clickable target matching {best_score} goal word(s): "{label[:80]}".',
    }


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
