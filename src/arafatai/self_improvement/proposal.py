"""PR-gated self-improvement proposal artifacts.

The generator turns a real failure into a reviewable improvement package:
eval case, lesson memory entry, test commands, branch/PR runbook, and a
machine-readable proposal. It never applies code changes or merges branches.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any

from arafatai.memory.lesson_store import Lesson, LessonStore


DEFAULT_TEST_COMMANDS = [
    "python -m pytest",
    "npm.cmd test --prefix tools/sidebar-bridge-node",
]

STOP_WORDS = {
    "about",
    "after",
    "again",
    "because",
    "before",
    "check",
    "could",
    "does",
    "from",
    "have",
    "into",
    "issue",
    "same",
    "that",
    "their",
    "there",
    "this",
    "when",
    "with",
    "working",
}


@dataclass(frozen=True)
class SelfImprovementInput:
    failure: str
    actual: str
    expected: str
    area: str = "general"
    root_cause: str = ""
    evidence: str = ""
    tags: list[str] = field(default_factory=list)
    test_commands: list[str] = field(default_factory=lambda: list(DEFAULT_TEST_COMMANDS))
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    proposal_id: str = ""

    def validate(self) -> None:
        if not self.failure.strip():
            raise ValueError("failure cannot be empty.")
        if not self.actual.strip():
            raise ValueError("actual cannot be empty.")
        if not self.expected.strip():
            raise ValueError("expected cannot be empty.")


class SelfImprovementProposalStore:
    def __init__(
        self,
        output_dir: str | Path = "runs/self-improvement",
        lesson_file: str | Path = "memory/lessons.jsonl",
    ) -> None:
        self.output_dir = Path(output_dir)
        self.lesson_file = Path(lesson_file)

    def create(self, data: SelfImprovementInput, *, write_lesson: bool = True) -> dict[str, Any]:
        data.validate()
        proposal_id = data.proposal_id or proposal_id_for(data)
        proposal_dir = self.output_dir / proposal_id
        proposal_dir.mkdir(parents=True, exist_ok=True)

        prior_matches = self.find_similar_failures(data.failure)
        repeat_count = len(prior_matches) + 1
        eval_case = build_eval_case(data, proposal_id)
        proposal = {
            "schema_version": "self-improvement-proposal/v1",
            "proposal_id": proposal_id,
            "created_at": data.created_at,
            "area": safe_text(data.area or "general"),
            "failure": safe_text(data.failure),
            "actual_behavior": safe_text(data.actual),
            "expected_behavior": safe_text(data.expected),
            "root_cause_hypothesis": safe_text(data.root_cause),
            "evidence": safe_text(data.evidence),
            "tags": sorted(set(safe_text(tag) for tag in data.tags if safe_text(tag))),
            "repeat_count": repeat_count,
            "repeated_failure_detected": repeat_count > 1,
            "similar_failures": prior_matches[:5],
            "eval_case_path": "eval-case.json",
            "proposal_path": "proposal.json",
            "pr_summary_path": "PR_SUMMARY.md",
            "runbook_path": "RUNBOOK.md",
            "test_commands": list(data.test_commands or DEFAULT_TEST_COMMANDS),
            "branch_name": f"codex/self-improve-{slugify(data.area)}-{proposal_id[-8:]}",
            "required_gate": "human_review_and_pr_merge",
            "auto_merge_allowed": False,
            "status": "proposal_only",
        }

        write_json(proposal_dir / "proposal.json", proposal)
        write_json(proposal_dir / "eval-case.json", eval_case)
        (proposal_dir / "PR_SUMMARY.md").write_text(build_pr_summary(proposal, eval_case), encoding="utf-8")
        (proposal_dir / "RUNBOOK.md").write_text(build_runbook(proposal), encoding="utf-8")

        lesson = None
        if write_lesson:
            lesson = LessonStore(self.lesson_file).append(
                Lesson(
                    lesson=f"Self-improvement candidate: {data.failure}",
                    source=f"self-improvement:{proposal_id}",
                    evidence=data.evidence or str(proposal_dir / "proposal.json"),
                    tags=["self-improvement", *proposal["tags"]],
                )
            )

        return {
            "ok": True,
            "proposal": proposal,
            "eval_case": eval_case,
            "lesson": lesson,
            "directory": str(proposal_dir),
        }

    def find_similar_failures(self, failure: str) -> list[dict[str, Any]]:
        if not self.lesson_file.exists():
            return []

        target_tokens = tokenize(failure)
        matches: list[dict[str, Any]] = []
        with self.lesson_file.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                haystack = " ".join(str(row.get(key, "")) for key in ("lesson", "source", "evidence", "tags"))
                if similarity(target_tokens, tokenize(haystack)) >= 0.35:
                    matches.append(
                        {
                            "lesson": str(row.get("lesson", ""))[:240],
                            "source": str(row.get("source", ""))[:160],
                            "created_at": row.get("created_at", ""),
                        }
                    )
        return matches[-10:]


def build_eval_case(data: SelfImprovementInput, proposal_id: str) -> dict[str, Any]:
    return {
        "schema_version": "self-improvement-eval/v1",
        "id": proposal_id,
        "area": safe_text(data.area or "general"),
        "failure": safe_text(data.failure),
        "actual_behavior": safe_text(data.actual),
        "expected_behavior": safe_text(data.expected),
        "root_cause_hypothesis": safe_text(data.root_cause),
        "evidence": safe_text(data.evidence),
        "tags": sorted(set(safe_text(tag) for tag in data.tags if safe_text(tag))),
        "regression_assertions": [
            "A failing eval or test must exist before planner/tool logic is changed.",
            safe_text(data.expected),
        ],
        "must_not": [
            "auto_merge",
            "skip_tests",
            "claim_fix_without_evidence",
        ],
    }


def build_pr_summary(proposal: dict[str, Any], eval_case: dict[str, Any]) -> str:
    tests = "\n".join(f"- [ ] `{command}`" for command in proposal["test_commands"])
    return "\n".join(
        [
            f"# Self-Improvement Proposal: {proposal['area']}",
            "",
            "## Problem",
            proposal["failure"],
            "",
            "## Observed Behavior",
            proposal["actual_behavior"],
            "",
            "## Expected Behavior",
            proposal["expected_behavior"],
            "",
            "## Evidence",
            proposal["evidence"] or "Evidence must be added before implementation.",
            "",
            "## Regression Eval",
            f"- Eval schema: `{eval_case['schema_version']}`",
            f"- Eval id: `{eval_case['id']}`",
            "",
            "## Verification",
            tests,
            "",
            "## Safety Gate",
            "- [ ] Human reviewed the diff.",
            "- [ ] Branch was pushed as a pull request.",
            "- [ ] No auto-merge was used.",
            "",
        ]
    )


def build_runbook(proposal: dict[str, Any]) -> str:
    tests = "\n".join(f"{index}. `{command}`" for index, command in enumerate(proposal["test_commands"], start=1))
    return "\n".join(
        [
            "# PR-Gated Self-Improvement Runbook",
            "",
            "1. Review `proposal.json` and `eval-case.json`.",
            f"2. Create branch: `git switch -c {proposal['branch_name']}`",
            "3. Add the regression eval or test first.",
            "4. Patch only the planner/tool code needed for that eval.",
            "5. Run verification:",
            tests,
            "6. Commit the eval and code changes together.",
            "7. Push the branch and open a pull request with `PR_SUMMARY.md`.",
            "8. Stop. A human must review and merge.",
            "",
            "Hard gate: auto_merge_allowed is false.",
            "",
        ]
    )


def proposal_id_for(data: SelfImprovementInput) -> str:
    timestamp = data.created_at.replace("-", "").replace(":", "").replace(".", "").replace("+", "Z")[:15]
    return f"{timestamp}-{slugify(data.area)}-{slugify(data.failure)[:48]}"


def tokenize(value: str) -> set[str]:
    tokens = {token for token in re.findall(r"[a-z0-9]+", value.lower()) if len(token) >= 3}
    return {token for token in tokens if token not in STOP_WORDS}


def similarity(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / max(1, min(len(left), len(right)))


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:72] or "proposal"


def safe_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
