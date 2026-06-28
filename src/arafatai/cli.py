"""Command line entrypoint for ArafatAI."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from arafatai.actions import BrowserAction
from arafatai.agents.planner import PlannerAgent
from arafatai.bridge.codex_cli import DEFAULT_TOKEN
from arafatai.bridge.core_reasoner import reason_with_python_core
from arafatai.bridge.server import BridgeServerConfig, run_server
from arafatai.evals.scorecard import evaluate_browser_snapshot, load_snapshot
from arafatai.memory.lesson_store import Lesson, LessonStore
from arafatai.self_improvement import SelfImprovementInput, SelfImprovementProposalStore
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

    bridge = subparsers.add_parser("bridge-server", help="Run local Codex CLI bridge for browser extension testing.")
    bridge.add_argument("--host", default="127.0.0.1", help="Bind host.")
    bridge.add_argument("--port", type=int, default=8792, help="Bind port.")
    bridge.add_argument("--token", default=DEFAULT_TOKEN, help="Required x-arafatai-token value.")
    bridge.add_argument("--codex-cli", help="Path to codex executable. Also supports ARAFATAI_CODEX_CLI_PATH.")
    bridge.add_argument("--cwd", default=".", help="Working directory passed to Codex CLI.")
    bridge.add_argument("--timeout", type=int, default=45, help="Codex CLI timeout in seconds.")
    bridge.add_argument(
        "--provider",
        choices=["codex", "core", "python-core"],
        default="codex",
        help="Planning provider for the Python HTTP bridge.",
    )

    sidebar_reason = subparsers.add_parser(
        "sidebar-reason",
        help="Read sidebar request JSON from stdin and return the Python-core provider response.",
    )
    sidebar_reason.add_argument("--input-file", help="Request JSON file. Defaults to stdin.")
    sidebar_reason.add_argument("--pretty", action="store_true", help="Pretty-print provider response JSON.")

    improve = subparsers.add_parser(
        "propose-self-improvement",
        aliases=["self-improve"],
        help="Create a PR-gated self-improvement proposal from a real failure.",
    )
    improve.add_argument("--failure", required=True, help="Short description of the failure.")
    improve.add_argument("--actual", required=True, help="What FLUID did or returned.")
    improve.add_argument("--expected", required=True, help="What should happen next time.")
    improve.add_argument("--area", default="general", help="Planner/tool area, e.g. directorist, wordpress, sidebar.")
    improve.add_argument("--root-cause", default="", help="Known or suspected root cause.")
    improve.add_argument("--evidence", default="", help="Evidence path, URL, or concise proof.")
    improve.add_argument("--tag", action="append", default=[], help="Tag. Can be passed more than once.")
    improve.add_argument("--test-command", action="append", default=[], help="Verification command. Can be repeated.")
    improve.add_argument("--output-dir", default="runs/self-improvement", help="Proposal artifact directory.")
    improve.add_argument("--lesson-file", default="memory/lessons.jsonl", help="Lesson memory JSONL file.")
    improve.add_argument("--no-memory", action="store_true", help="Do not append a lesson memory row.")

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

    if args.command == "bridge-server":
        run_server(
            BridgeServerConfig(
                host=args.host,
                port=args.port,
                token=args.token,
                codex_path=args.codex_cli,
                cwd=Path(args.cwd).resolve(),
                timeout_seconds=args.timeout,
                provider=args.provider,
            )
        )
        return

    if args.command == "sidebar-reason":
        raw = Path(args.input_file).read_text(encoding="utf-8") if args.input_file else sys.stdin.read()
        try:
            parsed = json.loads(raw or "{}")
        except json.JSONDecodeError as exc:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "text": "",
                        "source": "python-core",
                        "error": f"invalid_json: {exc}",
                    }
                )
            )
            raise SystemExit(1) from exc
        if not isinstance(parsed, dict):
            print(json.dumps({"ok": False, "text": "", "source": "python-core", "error": "request_must_be_object"}))
            raise SystemExit(1)
        result = reason_with_python_core(parsed).to_dict()
        print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
        if not result["ok"]:
            raise SystemExit(1)
        return

    if args.command in {"propose-self-improvement", "self-improve"}:
        result = SelfImprovementProposalStore(
            output_dir=args.output_dir,
            lesson_file=args.lesson_file,
        ).create(
            SelfImprovementInput(
                failure=args.failure,
                actual=args.actual,
                expected=args.expected,
                area=args.area,
                root_cause=args.root_cause,
                evidence=args.evidence,
                tags=args.tag,
                test_commands=args.test_command or None,
            ),
            write_lesson=not args.no_memory,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return


if __name__ == "__main__":
    main()
