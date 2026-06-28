const TASK_TYPES = new Set([
  'browser_only',
  'investigation',
  'engineering_fix',
  'review_only',
  'risky_action',
  'unknown',
]);

const DOMAINS = new Set([
  'wordpress',
  'directorist',
  'github',
  'local_repo',
  'generic_web',
  'unknown',
]);

const RISK_LEVELS = new Set(['safe', 'needs_confirmation', 'blocked']);

const RISKY_ACTION_RE = /\b(reset|delete|remove|destroy|wipe|erase|drop|truncate|publish|deploy|merge|payment|pay|checkout|purchase|submit|post|password|credential|database|db)\b/i;
const CONFIRMATION_RE = /\b(yes|yeah|yep|confirm|confirmed|proceed|go ahead|approve|approved|ok|okay|sure|ji|jee|ha|haan|hmm|korbo|koro|kore dao|local site)\b/i;
const REVIEW_ONLY_RE = /\b(list first|age ekta list|plan first|audit|explain|logic only|do not implement|don't implement|dont implement|documentation|doc only|review only|read only|no code change|no change)\b/i;
const INVESTIGATION_RE = /\b(check|investigate|debug|diagnose|why|issue|problem|bug|not working|does not work|no result|no results|missing|hidden|blank|responsive|dropdown|field|validation|csv|export|booking|geolocat|geo locating|radius|search returns|display issue|fix hoise|kaj kore)\b/i;
const FIX_RE = /\b(fix|fixing|patch|implement|code|child theme|child-theme|functions\.php|mu-plugin|snippet|apply|edit|update file|koro|kore dao|solve|repair)\b/i;
const BROWSER_ACTION_RE = /\b(open|go to|goto|navigate|jao|search|google|click|type|press|screenshot|dekhao|show|visit)\b/i;
const WORDPRESS_RE = /\b(wordpress|wp-admin|wp login|wp-login|theme|plugin|child theme|functions\.php|code snippets|woocommerce|elementor)\b/i;
const DIRECTORIST_RE = /\b(directorist|at_biz_dir|listing|directory|add listing|booking|radius search|geo|geolocat|csv export|single listing)\b/i;
const GITHUB_RE = /\b(github|pull request|pr\b|branch|commit|push|merge)\b/i;
const LOCAL_REPO_RE = /\b(repo|repository|workspace|local file|filesystem|git status|npm test|php -l|lint|shell|terminal)\b/i;
const NEGATIVE_ACTION_RE = /\b(do not|don't|dont|never|not|without asking|age jiggesh|ask first)\b[^.?!]{0,100}\b(reset|delete|remove|publish|deploy|merge|submit|post|payment|pay|checkout|database|db)\b/i;

export function classifyTask(body = {}) {
  const goal = normalize(String(body.goal || body.message || ''));
  const page = isPlainObject(body.page) ? body.page : {};
  const memory = normalize(JSON.stringify(isPlainObject(body.conversation_memory) ? body.conversation_memory : {}));
  const haystack = normalize(`${goal} ${page.url || ''} ${page.title || ''} ${page.visible_text || ''}`);
  const domain = classifyDomain(haystack);
  const safetyBoundary = NEGATIVE_ACTION_RE.test(goal);
  const explicitRisk = RISKY_ACTION_RE.test(goal) && !safetyBoundary;
  const hasApproval = CONFIRMATION_RE.test(goal);
  const asksReviewOnly = REVIEW_ONLY_RE.test(goal);
  const asksFix = FIX_RE.test(goal);
  const asksInvestigation = INVESTIGATION_RE.test(goal);
  const asksBrowserAction = BROWSER_ACTION_RE.test(goal);
  const investigationFirst = asksInvestigation && isInvestigationFirstGoal(goal);

  if (!goal) {
    return result({
      task_type: 'unknown',
      domain,
      risk_level: 'safe',
      evidence_needed: ['user_goal'],
      reason: 'No user goal was supplied.',
    });
  }

  if (asksReviewOnly) {
    return result({
      task_type: 'review_only',
      domain,
      risk_level: 'safe',
      evidence_needed: evidenceForReview(domain),
      reason: 'The user asked for planning, review, audit, or documentation before implementation.',
    });
  }

  if (explicitRisk && !hasApproval) {
    return result({
      task_type: 'risky_action',
      domain,
      risk_level: 'needs_confirmation',
      evidence_needed: ['explicit_user_confirmation', ...domainEvidence(domain)],
      reason: 'The request contains a risky action without explicit approval.',
    });
  }

  if (explicitRisk && hasApproval) {
    return result({
      task_type: 'risky_action',
      domain,
      risk_level: 'needs_confirmation',
      evidence_needed: ['target_confirmation', ...domainEvidence(domain)],
      reason: 'The request approves a risky action, so the target still needs confirmation before execution.',
    });
  }

  if (asksFix && !investigationFirst) {
    return result({
      task_type: 'engineering_fix',
      domain,
      risk_level: domain === 'generic_web' || domain === 'unknown' ? 'needs_confirmation' : 'needs_confirmation',
      evidence_needed: evidenceForFix(domain, { goal, safetyBoundary, memory }),
      reason: 'The user asked for an implementation or code-level fix.',
    });
  }

  if (asksInvestigation || safetyBoundary) {
    return result({
      task_type: 'investigation',
      domain,
      risk_level: 'safe',
      evidence_needed: evidenceForInvestigation(domain, { goal, safetyBoundary }),
      reason: safetyBoundary
        ? 'The request includes safety boundaries, so only observation and investigation are allowed.'
        : 'The user described a bug or support issue that needs evidence before a fix.',
    });
  }

  if (asksBrowserAction) {
    return result({
      task_type: 'browser_only',
      domain,
      risk_level: 'safe',
      evidence_needed: ['page_snapshot'],
      reason: 'The request maps to a reversible browser navigation or page action.',
    });
  }

  return result({
    task_type: 'unknown',
    domain,
    risk_level: 'safe',
    evidence_needed: ['page_snapshot', 'clarifying_goal'],
    reason: 'The request could not be mapped to a safe mode yet.',
  });
}

function isInvestigationFirstGoal(goal) {
  const text = normalize(goal).toLowerCase();
  if (/\b(apply|patch|implement|code dao|exact code|solve|repair|fix koro|fixing koro)\b/.test(text)) return false;
  return /\b(investigate|check|debug|diagnose|why|before editing|before proposing|before changing|preserve|compare)\b/.test(text);
}

function classifyDomain(text) {
  if (DIRECTORIST_RE.test(text)) return 'directorist';
  if (WORDPRESS_RE.test(text)) return 'wordpress';
  if (GITHUB_RE.test(text)) return 'github';
  if (LOCAL_REPO_RE.test(text)) return 'local_repo';
  if (/\bhttps?:\/\//i.test(text) || /\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(text)) return 'generic_web';
  return 'unknown';
}

function evidenceForReview(domain) {
  return unique(['current_context', ...domainEvidence(domain)]);
}

function evidenceForInvestigation(domain, { goal = '', safetyBoundary = false } = {}) {
  const base = ['page_snapshot', 'reproduction_steps'];
  if (safetyBoundary) base.push('safety_boundary');
  return unique([...base, ...domainEvidence(domain), ...supportCaseEvidence(goal, domain)]);
}

function evidenceForFix(domain, { goal = '' } = {}) {
  return unique([
    'root_cause_summary',
    'target_surface',
    'backup_or_git_status',
    'syntax_or_test_output',
    'verification_result',
    ...domainEvidence(domain),
    ...supportCaseEvidence(goal, domain),
  ]);
}

function domainEvidence(domain) {
  switch (domain) {
    case 'directorist':
      return ['wordpress_session', 'active_theme_or_plugin', 'directorist_settings_or_rest', 'request_payload'];
    case 'wordpress':
      return ['wordpress_session', 'active_theme_or_plugin', 'admin_route'];
    case 'github':
      return ['git_status', 'branch_or_pr_context'];
    case 'local_repo':
      return ['git_status', 'file_paths', 'test_command'];
    case 'generic_web':
      return ['current_url', 'page_snapshot'];
    default:
      return [];
  }
}

function supportCaseEvidence(goal, domain) {
  const text = normalize(goal).toLowerCase();
  const evidence = [];

  if (domain === 'directorist') {
    if (/\b(geo|geolocat|radius|no result|no results)\b/.test(text)) {
      evidence.push('submitted_form_fields', 'duplicate_field_scope', 'published_listing_status');
    }
    if (/\b(preview|draft|private|pending|public search)\b/.test(text)) {
      evidence.push('published_listing_status');
    }
    if (/\b(booking|time|dropdown|slot)\b/.test(text)) {
      evidence.push('existing_fix_review', 'comparable_working_flow', 'browser_dom_assertion');
    }
    if (/\b(csv|export|missing field|missing fields)\b/.test(text)) {
      evidence.push('export_source', 'db_or_meta_key');
    }
    if (/\b(add listing|image required|upload|validation)\b/.test(text)) {
      evidence.push('form_validation_rule', 'uploaded_file_state');
    }
  }

  if (domain === 'wordpress' && /\b(login|dashboard|wp-admin|redirect)\b/.test(text)) {
    evidence.push('redirect_chain');
  }

  if (/\b(responsive|hidden|display issue|button|logo)\b/.test(text)) {
    evidence.push('viewport_screenshot', 'browser_dom_assertion');
  }

  return evidence;
}

function result(value) {
  const taskType = TASK_TYPES.has(value.task_type) ? value.task_type : 'unknown';
  const domain = DOMAINS.has(value.domain) ? value.domain : 'unknown';
  const riskLevel = RISK_LEVELS.has(value.risk_level) ? value.risk_level : 'safe';
  return {
    task_type: taskType,
    domain,
    risk_level: riskLevel,
    evidence_needed: unique(value.evidence_needed || []),
    reason: normalize(value.reason || 'Task classified.'),
  };
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unique(items) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => normalize(item)).filter(Boolean))];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
