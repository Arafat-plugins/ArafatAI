from arafatai.bridge.task_store import TaskStore


def test_task_store_creates_and_appends_events(tmp_path):
    store = TaskStore(tmp_path)
    task = store.create("open youtube", history=[{"role": "user", "text": "youtube a jao"}])

    assert task["id"]
    assert task["status"] == "running"

    updated = store.append_event(
        task["id"],
        {
            "kind": "observation",
            "status": "done",
            "message": "Opened YouTube.",
        },
    )

    assert updated is not None
    assert updated["status"] == "done"
    assert updated["events"][0]["event_id"] == 1
    assert updated["events"][0]["kind"] == "observation"
    assert store.get(task["id"])["events"][0]["message"] == "Opened YouTube."


def test_task_store_returns_recent_observations(tmp_path):
    store = TaskStore(tmp_path)
    task = store.create("task")
    store.append_event(task["id"], {"kind": "plan", "message": "planned"})
    store.append_event(task["id"], {"kind": "observation", "message": "first"})
    store.append_event(task["id"], {"kind": "observation", "message": "second"})

    observations = store.observations(task["id"], limit=1)

    assert len(observations) == 1
    assert observations[0]["message"] == "second"
