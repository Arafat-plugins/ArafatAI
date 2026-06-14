from arafatai.evals.scorecard import evaluate_browser_snapshot
from arafatai.memory.lesson_store import Lesson, LessonStore


def test_lesson_store_append_and_search(tmp_path):
    store = LessonStore(tmp_path / "lessons.jsonl")
    store.append(Lesson(lesson="Browser modal needed a real click.", source="test", tags=["browser"]))

    results = store.search("modal")
    assert len(results) == 1
    assert results[0]["lesson"] == "Browser modal needed a real click."


def test_browser_snapshot_eval_passes_required_text():
    snapshot = {
        "url": "https://example.test",
        "title": "Example",
        "visible_text": "Sign up Here",
        "clickables": [{"text": "Here", "selector": "a.login"}],
    }
    result = evaluate_browser_snapshot(snapshot, must_contain=["Here"], min_clickables=1)

    assert result.passed is True
    assert result.score == 1.0


def test_browser_snapshot_eval_fails_missing_text():
    snapshot = {"visible_text": "Nothing", "clickables": []}
    result = evaluate_browser_snapshot(snapshot, must_contain=["Here"], min_clickables=1)

    assert result.passed is False
