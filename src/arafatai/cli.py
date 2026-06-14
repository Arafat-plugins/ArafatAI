"""Command line entrypoint for ArafatAI."""

from __future__ import annotations

import argparse

from arafatai.agents.planner import PlannerAgent


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="arafatai")
    parser.add_argument(
        "--goal",
        help="Goal for the planner agent. The first scaffold only prints a plan placeholder.",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if not args.goal:
        parser.print_help()
        return

    planner = PlannerAgent()
    plan = planner.plan(args.goal)
    print(plan)


if __name__ == "__main__":
    main()
