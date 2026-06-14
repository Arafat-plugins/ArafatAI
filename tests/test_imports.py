from arafatai.agents.planner import PlannerAgent


def test_planner_scaffold_returns_goal():
    result = PlannerAgent().plan("test goal")
    assert "test goal" in result
    assert "Planner scaffold" in result
