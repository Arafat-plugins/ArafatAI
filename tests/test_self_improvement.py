import json
import sys

from arafatai.cli import main
from arafatai.memory.lesson_store import Lesson, LessonStore
from arafatai.self_improvement import SelfImprovementInput, SelfImprovementProposalStore


def test_self_improvement_proposal_writes_gated_artifacts(tmp_path):
    store = SelfImprovementProposalStore(
        output_dir=tmp_path / "proposals",
        lesson_file=tmp_path / "memory" / "lessons.jsonl",
    )
    result = store.create(
        SelfImprovementInput(
            proposal_id="case-001",
            failure="Geo search returned no results after location detection.",
            actual="FLUID claimed the result was fixed without request evidence.",
            expected="FLUID must inspect submitted coordinates before suggesting a child-theme patch.",
            area="directorist",
            root_cause="Missing submitted cityLat/cityLng evidence.",
            evidence="runs/bridge-tasks/task/evidence/search-form.json",
            tags=["directorist", "geo-search"],
            test_commands=["python -m pytest tests/test_self_improvement.py"],
        )
    )

    proposal_dir = tmp_path / "proposals" / "case-001"
    proposal = json.loads((proposal_dir / "proposal.json").read_text(encoding="utf-8"))
    eval_case = json.loads((proposal_dir / "eval-case.json").read_text(encoding="utf-8"))
    runbook = (proposal_dir / "RUNBOOK.md").read_text(encoding="utf-8")

    assert result["ok"] is True
    assert proposal["auto_merge_allowed"] is False
    assert proposal["required_gate"] == "human_review_and_pr_merge"
    assert proposal["branch_name"].startswith("codex/self-improve-directorist-")
    assert eval_case["schema_version"] == "self-improvement-eval/v1"
    assert "auto_merge" in eval_case["must_not"]
    assert "A human must review and merge" in runbook
    assert (proposal_dir / "PR_SUMMARY.md").exists()
    assert (tmp_path / "memory" / "lessons.jsonl").exists()


def test_self_improvement_detects_repeated_failure_from_lesson_memory(tmp_path):
    lesson_file = tmp_path / "lessons.jsonl"
    LessonStore(lesson_file).append(
        Lesson(
            lesson="Self-improvement candidate: Geo search returned no results after location detection.",
            source="prior-test",
            evidence="cityLat cityLng were blank",
            tags=["directorist", "geo-search"],
        )
    )

    result = SelfImprovementProposalStore(
        output_dir=tmp_path / "proposals",
        lesson_file=lesson_file,
    ).create(
        SelfImprovementInput(
            proposal_id="case-002",
            failure="Geo search returned no results after location detection.",
            actual="It guessed the fix.",
            expected="It should collect request evidence first.",
            area="directorist",
        ),
        write_lesson=False,
    )

    assert result["proposal"]["repeat_count"] == 2
    assert result["proposal"]["repeated_failure_detected"] is True
    assert result["proposal"]["similar_failures"][0]["source"] == "prior-test"


def test_self_improvement_cli_creates_proposal(tmp_path, monkeypatch, capsys):
    output_dir = tmp_path / "proposals"
    lesson_file = tmp_path / "lessons.jsonl"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "arafatai",
            "propose-self-improvement",
            "--failure",
            "Sidebar repeated a failed click target.",
            "--actual",
            "It clicked the same stale selector again.",
            "--expected",
            "It should stop and request fresh evidence.",
            "--area",
            "sidebar",
            "--output-dir",
            str(output_dir),
            "--lesson-file",
            str(lesson_file),
            "--no-memory",
        ],
    )

    main()
    response = json.loads(capsys.readouterr().out)

    assert response["ok"] is True
    assert response["proposal"]["area"] == "sidebar"
    assert response["proposal"]["auto_merge_allowed"] is False
    assert (output_dir / response["proposal"]["proposal_id"] / "proposal.json").exists()
    assert not lesson_file.exists()
