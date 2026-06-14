"""Command line entrypoint for ArafatAI."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from arafatai.actions import BrowserAction
from arafatai.agents.planner import PlannerAgent
from arafatai.evals.scorecard import evaluate_browser_snapshot, load_snapshot
from arafatai.memory.lesson_store import Lesson, LessonStore
from arafatai.tools.browser_tool import BrowserTool


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="arafatai")
    subparsers = parser.add_subparsers(dest="command")

    plan = subparsers.add_parser("plan", help="Create a planner scaffold response.")
    plan.add_argument("--goal", required=True, help="Goal for the planner agent.")

    browser = subparsers.add_parser("browser-action", help="Run validated browser action JSON.")
    browser.add_argument("--url", required=True, help="Target URL.")
    browser.add_argument(
        "--action",
        action="append",
        help='Action JSON. Example: {"type":"click","target":"text=Here"}',
    )
    browser.add_argument(
        "--actions-file",
        help="Path to a JSON file containing one action object or a list of action objects.",
    )
    browser.add_argument("--yes", action="store_true", help="Allow risky actions.")
    browser.add_argument("--headed", action="store_true", help="Run browser visibly instead of headless.")
    browser.add_argument("--user-data-dir", help="Browser profile directory for logged-in sessions.")
    browser.add_argument("--keep-open", action="store_true", help="Keep browser open after action.")

    snapshot = subparsers.add_parser("browser-snapshot", help="Read page state into JSON.")
    snapshot.add_argument("--url", required=True, help="Target URL.")
    snapshot.add_argument("--output", default="runs/snapshot.json", help="Snapshot JSON output path.")
    snapshot.add_argument("--headed", action="store_true", help="Run browser visibly instead of headless.")
    snapshot.add_argument("--user-data-dir", help="Browser profile directory for logged-in sessions.")
    snapshot.add_argument("--keep-open", action="store_true", help="Keep browser open after snapshot.")

    remember = subparsers.add_parser("remember", help="Append a lesson to local memory.")
    remember.add_argument("--lesson", required=True, help="Lesson text.")
    remember.add_argument("--source", required=True, help="Where the lesson came from.")
    remember.add_argument("--evidence", help="Short evidence or file path.")
    remember.add_argument("--tag", action="append", default=[], help="Tag. Can be passed more than once.")
    remember.add_argument("--memory-file", default="memory/lessons.jsonl", help="JSONL memory file.")

    eval_snapshot = subparsers.add_parser("eval-browser-snapshot", help="Score a browser snapshot JSON file.")
    eval_snapshot.add_argument("--snapshot", required=True, help="Path to snapshot JSON.")
    eval_snapshot.add_argument("--must-contain", action="append", default=[], help="Text that must be present.")
    eval_snapshot.add_argument("--min-clickables", type=int, default=0, help="Minimum clickable elements expected.")

    parser.add_argument(
        "--goal",
        help="Backward-compatible shortcut for: arafatai plan --goal ...",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.goal and not args.command:
        args.command = "plan"

    if not args.command:
        parser.print_help()
        return

    if args.command == "plan":
        planner = PlannerAgent()
        plan = planner.plan(args.goal)
        print(plan)
        return

    if args.command == "browser-action":
        try:
            action_payloads = list(args.action or [])
            if args.actions_file:
                raw = Path(args.actions_file).read_text(encoding="utf-8")
                parsed = json.loads(raw)
                if isinstance(parsed, list):
                    action_payloads.extend(json.dumps(item) for item in parsed)
                elif isinstance(parsed, dict):
                    action_payloads.append(json.dumps(parsed))
                else:
                    raise ValueError("--actions-file must contain a JSON object or array.")
            if not action_payloads:
                raise ValueError("Provide --action or --actions-file.")
            actions = [BrowserAction.from_json(raw) for raw in action_payloads]
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Invalid actions file JSON: {exc}") from exc
        except ValueError as exc:
            raise SystemExit(f"Invalid browser action: {exc}") from exc

        result = BrowserTool().run_actions(
            args.url,
            actions,
            allow_risky=args.yes,
            headless=not args.headed,
            user_data_dir=args.user_data_dir,
            keep_open=args.keep_open,
        )
        print(json.dumps({"ok": result.ok, "message": result.message, "data": result.data}, indent=2))
        if not result.ok:
            raise SystemExit(1)

    if args.command == "browser-snapshot":
        result = BrowserTool().snapshot(
            args.url,
            output=args.output,
            headless=not args.headed,
            user_data_dir=args.user_data_dir,
            keep_open=args.keep_open,
        )
        print(json.dumps({"ok": result.ok, "message": result.message, "data": result.data}, indent=2))
        if not result.ok:
            raise SystemExit(1)
        return

    if args.command == "remember":
        row = LessonStore(args.memory_file).append(
            Lesson(
                lesson=args.lesson,
                source=args.source,
                evidence=args.evidence,
                tags=args.tag,
            )
        )
        print(json.dumps({"ok": True, "lesson": row}, indent=2))
        return

    if args.command == "eval-browser-snapshot":
        snapshot = load_snapshot(args.snapshot)
        result = evaluate_browser_snapshot(
            snapshot,
            must_contain=args.must_contain,
            min_clickables=args.min_clickables,
        )
        print(json.dumps(result.to_dict(), indent=2))
        if not result.passed:
            raise SystemExit(1)
        return


if __name__ == "__main__":
    main()
