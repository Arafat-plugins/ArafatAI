import pytest

from arafatai.actions import BrowserAction


def test_click_action_from_json():
    action = BrowserAction.from_json('{"type":"click","target":"text=Here"}')
    assert action.type == "click"
    assert action.target == "text=Here"
    assert action.to_node_cli_args() == ["--click", "text=Here"]


def test_type_action_requires_value():
    with pytest.raises(ValueError):
        BrowserAction.from_json('{"type":"type","target":"input[name=email]"}')


def test_risky_action_detected():
    action = BrowserAction.from_json('{"type":"click","target":"text=Publish"}')
    assert action.risky is True


def test_wait_action_cli_args():
    action = BrowserAction.from_json('{"type":"wait","value":1000}')
    assert action.to_node_cli_args() == ["--wait", "1000"]


def test_snapshot_action_cli_args():
    action = BrowserAction.from_json('{"type":"snapshot","value":"runs/snapshot.json"}')
    assert action.to_node_cli_args() == ["--snapshot", "runs/snapshot.json"]
