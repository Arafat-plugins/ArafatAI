import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { buildLocalAgentReply } from '../src/local-planner.mjs';
import { classifyTask } from '../src/task-classifier.mjs';
import { normalizeWordPressEntryUrl, wordpressAdminPageUrl } from '../src/wordpress-tools.mjs';

const SUPPORT_CASES_URL = new URL('../../../src/arafatai/evals/support_cases/directorist-support-cases.json', import.meta.url);

async function loadSupportCases() {
  const data = JSON.parse(await readFile(SUPPORT_CASES_URL, 'utf8'));
  assert.equal(data.schema_version, 'support-case-evals/v1');
  assert.ok(Array.isArray(data.cases));
  assert.ok(data.cases.length >= 6);
  return data.cases;
}

function parsePlannerReply(body, options = {}) {
  const raw = buildLocalAgentReply(body, options);
  return raw ? JSON.parse(raw) : null;
}

test('support case fixtures classify into expected mode, domain, risk, and evidence gates', async () => {
  const cases = await loadSupportCases();

  for (const item of cases) {
    const classification = classifyTask({
      goal: item.goal,
      page: item.page || {},
    });
    const expected = item.expected?.classification || {};

    assert.equal(classification.task_type, expected.task_type, `${item.id}: task_type`);
    assert.equal(classification.domain, expected.domain, `${item.id}: domain`);
    assert.equal(classification.risk_level, expected.risk_level, `${item.id}: risk_level`);

    for (const evidence of expected.evidence_needed_includes || []) {
      assert.ok(
        classification.evidence_needed.includes(evidence),
        `${item.id}: missing evidence gate ${evidence}; got ${classification.evidence_needed.join(', ')}`,
      );
    }
  }
});

test('support case fixtures preserve user-provided WordPress login routes', async () => {
  const cases = await loadSupportCases();
  const routeCases = cases.filter((item) => item.wordpress_route);
  assert.ok(routeCases.length >= 1);

  for (const item of routeCases) {
    const route = item.wordpress_route;
    assert.equal(normalizeWordPressEntryUrl(route.entry_url), route.expected_entry_url, `${item.id}: entry URL`);
    assert.equal(wordpressAdminPageUrl(route.entry_url, route.admin_page), route.expected_admin_url, `${item.id}: admin URL`);
  }
});

test('support case fixtures keep negative reset safety wording away from WP Reset automation', async () => {
  const cases = await loadSupportCases();
  const guarded = cases.filter((item) => item.expected?.local_planner?.not_action_target_contains);
  assert.ok(guarded.length >= 1);

  for (const item of guarded) {
    const data = parsePlannerReply({
      mode: 'agent_task',
      goal: item.goal,
      page: item.page || {},
    }, { allowQuestionFallback: false });
    const targets = (data?.actions || []).map((action) => String(action.target || action.value || ''));

    for (const blocked of item.expected.local_planner.not_action_target_contains) {
      assert.equal(
        targets.some((target) => target.includes(blocked)),
        false,
        `${item.id}: local planner target should not include ${blocked}`,
      );
    }
  }
});
