import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyTask } from '../src/task-classifier.mjs';

test('classifies simple navigation as browser-only', () => {
  const data = classifyTask({
    goal: 'open google.com',
    page: { url: 'chrome://newtab/', title: 'New Tab' },
  });

  assert.equal(data.task_type, 'browser_only');
  assert.equal(data.domain, 'generic_web');
  assert.equal(data.risk_level, 'safe');
  assert.ok(data.evidence_needed.includes('page_snapshot'));
});

test('classifies Directorist no-results issue as investigation', () => {
  const data = classifyTask({
    goal: 'Geo locating search always says No Results but listings should be inside radius',
    page: { url: 'https://yourspace.global/', title: 'Your Space' },
  });

  assert.equal(data.task_type, 'investigation');
  assert.equal(data.domain, 'directorist');
  assert.equal(data.risk_level, 'safe');
  assert.ok(data.evidence_needed.includes('request_payload'));
  assert.ok(data.evidence_needed.includes('directorist_settings_or_rest'));
});

test('classifies child-theme implementation as engineering fix with evidence gates', () => {
  const data = classifyTask({
    goal: 'Fix this Directorist issue in child theme functions.php',
    page: { url: 'https://example.test/wp-admin/theme-editor.php', title: 'Edit Themes - WordPress' },
  });

  assert.equal(data.task_type, 'engineering_fix');
  assert.equal(data.domain, 'directorist');
  assert.equal(data.risk_level, 'needs_confirmation');
  assert.ok(data.evidence_needed.includes('backup_or_git_status'));
  assert.ok(data.evidence_needed.includes('syntax_or_test_output'));
  assert.ok(data.evidence_needed.includes('verification_result'));
});

test('does not treat negative reset safety wording as reset intent', () => {
  const data = classifyTask({
    goal: 'Investigate this WordPress listing issue. Do not publish/delete/reset anything without asking.',
    page: { url: 'https://goldcoastspeakers.com.au/dashboard', title: 'Dashboard' },
  });

  assert.notEqual(data.task_type, 'risky_action');
  assert.equal(data.task_type, 'investigation');
  assert.equal(data.risk_level, 'safe');
  assert.ok(data.evidence_needed.includes('safety_boundary'));
});

test('classifies direct reset request as risky action needing confirmation', () => {
  const data = classifyTask({
    goal: 'reset this local WordPress site',
    page: { url: 'https://local.test/wp-admin/', title: 'Dashboard - WordPress' },
  });

  assert.equal(data.task_type, 'risky_action');
  assert.equal(data.domain, 'wordpress');
  assert.equal(data.risk_level, 'needs_confirmation');
  assert.ok(data.evidence_needed.includes('explicit_user_confirmation'));
});

test('classifies plan-first request as review-only', () => {
  const data = classifyTask({
    goal: 'age ekta list koro kivabe implement korbe, do not implement yet',
    page: { url: 'https://example.test/', title: 'Example' },
  });

  assert.equal(data.task_type, 'review_only');
  assert.equal(data.risk_level, 'safe');
  assert.ok(data.evidence_needed.includes('current_context'));
});
