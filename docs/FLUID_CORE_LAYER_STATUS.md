# FLUID Core Layer Status

Date: 2026-06-28

This document records the current FLUID/ArafatAI Chrome sidebar engineering upgrade status, the work completed in the latest implementation pass, and the remaining core layers needed before the tool feels closer to a Codex-style local engineering assistant.

## Current Goal

Build FLUID into a practical local engineering assistant that can:

1. Understand the user goal from the active browser/page context.
2. Collect real evidence from browser, HTTP, WordPress, files, Git, and tests.
3. Choose the smallest safe fix.
4. Apply code changes through a guarded patch workflow.
5. Verify results before claiming the issue is fixed.
6. Preserve lessons and evidence so similar failures do not repeat.

## Completed Work In This Pass

### Planning And Architecture

- Added a detailed engineering upgrade plan in `docs/FLUID_ENGINEERING_UPGRADE_PLAN.md`.
- Generated a PDF copy of the upgrade plan in `docs/FLUID_ENGINEERING_UPGRADE_PLAN.pdf`.
- Updated project docs to describe the Node bridge, Python core integration, evidence workflow, and sidebar flow.

### Task Classification

- Added `tools/sidebar-bridge-node/src/task-classifier.mjs`.
- Added support-case classification coverage for WordPress/Directorist support tasks.
- Classified tasks into safer modes such as browser-only, investigation, review-only, engineering-fix, and risky-action.
- Added evidence gates for tasks like responsive bugs, CSV export bugs, geolocation issues, add-listing validation, and booking-flow issues.

### Evidence Store

- Added `tools/sidebar-bridge-node/src/evidence-store.mjs`.
- Task evidence is stored under bridge task folders with compact metadata.
- Browser verification payloads can be compacted and passed back into later planning turns.
- Evidence is now shown in the sidebar overview instead of staying hidden in task files.

### Desktop Tool Adapter

- Added `tools/sidebar-bridge-node/src/tool-registry.mjs`.
- Added safe read-only and verification tools for HTTP, WordPress admin checks, file reads/searches, Git status/diff, lint/test commands, and browser CDP checks.
- Blocked write-like tool actions before execution unless they go through the guarded patch workflow.

### WordPress Support Toolkit

- Added `tools/sidebar-bridge-node/src/wordpress-tools.mjs`.
- Added WordPress login/session helpers that preserve real login routes instead of guessing `wp-login.php`.
- Added active theme and plugin evidence collection for support debugging.
- Added tests for hidden dashboard routes, active theme parsing, plugin rows, and WordPress admin evidence.

### Patch Workflow

- Added `tools/sidebar-bridge-node/src/patch-workflow.mjs`.
- Added a guarded patch flow that prepares a backup and patched copy first.
- Added syntax-check support against the prepared copy.
- Added stale-file protection before applying a prepared patch.
- Added tests for blocked apply, approved apply, stale apply, and workspace path protection.

### Browser DevTools Verification

- Added `tools/sidebar-bridge-node/src/chrome-cdp.mjs`.
- Added `chrome_cdp_check` tool support.
- The tool can collect viewport, geolocation, selector assertion, network, screenshot, image, clickable, and layout evidence.
- Browser verification evidence is stored and reused by later planning calls.

### Sidebar UX

- Updated `extensions/chrome-sidebar/sidepanel.js`.
- Updated `extensions/chrome-sidebar/sidepanel.css`.
- Added a task overview card with rows for Goal, Mode, Risk Gate, Evidence, Patch, Verification, Files Changed, and Next Action.
- Browser/CDP evidence now appears under `Verification`, not as generic evidence.
- Browser check pass/fail status is shown with useful text and tone.
- Blocked tool/risky action evidence now appears under `Risk gate`.
- Approval gates now show `Needs approval` instead of looking like a hard failure.
- Sidebar width is constrained so it behaves like a sidebar instead of expanding like a full page.

### Python Core Integration

- Added `src/arafatai/bridge/core_reasoner.py`.
- Added `tools/sidebar-bridge-node/src/python-core-provider.mjs`.
- Updated bridge/server routing so the Node bridge can delegate planning to the Python core while keeping the Chrome-facing HTTP contract stable.
- Added Python tests for core reasoning behavior and browser verification memory handling.

### Self-Improvement Foundation

- Added `src/arafatai/self_improvement/`.
- Added proposal generation tests.
- Kept self-improvement PR-gated by design: the tool can propose changes, but should not silently rewrite itself without review.

### Evals And Fixtures

- Added `src/arafatai/evals/support_cases/`.
- Added support-case tests for common WordPress/Directorist support issues.
- Added Node test coverage for the bridge, tool registry, support cases, evidence store, patch workflow, Chrome CDP tool, task classifier, and WordPress tools.

## Verification Completed

Latest checks run successfully:

- `node --check extensions/chrome-sidebar/sidepanel.js`
- Node bridge tests: `79 passed`
- Python tests: `67 passed`
- Edge unpacked-extension smoke test loaded the extension ID `gmcjjhmlogkebgjfmgknnlnpllcipmod`.
- Smoke screenshot saved at `runs/browser-evidence/fluid-sidebar-verification-smoke.png`.

Known environment note:

- This machine's installed Google Chrome rejects CLI `--load-extension` with `--load-extension is not allowed in Google Chrome, ignoring.`
- Automated unpacked-extension smoke verification currently uses Microsoft Edge, which loads the same Chromium extension code successfully.
- The user's real Chrome extension reload workflow remains: open `chrome://extensions`, reload the unpacked FLUID extension from `extensions/chrome-sidebar`, then verify bridge health.

## Remaining Core Layers

### 1. Stable Desktop Bridge

Status: partially implemented.

What remains:

- One command to start the bridge, verify health, and print the active provider.
- Better process management so stale bridge instances do not confuse the sidebar.
- Clear startup diagnostics for token mismatch, port conflict, missing Python path, and provider failure.
- A small local status endpoint that reports available tools, workspace root, provider, and last task.

Why it matters:

- The extension is not standalone. It needs a reliable local bridge to safely access files, Git, WordPress, tests, and browser verification.

### 2. Existing Chrome Control

Status: partially implemented.

What remains:

- Reliable attach flow for the user's already-open Chrome profile.
- Existing profile CDP discovery that can identify the active tab and extension side panel without launching a temporary browser.
- Safer fallback when Chrome blocks automation flags.
- A documented reload-and-verify flow that can detect whether the installed extension path matches the repo path.

Why it matters:

- Most real support work depends on already logged-in browser sessions. Temp-browser tests are not enough for live WordPress dashboards.

### 3. Full Safe Patch Application

Status: foundation implemented.

What remains:

- A reviewable diff UI inside the sidebar.
- Explicit approval buttons for prepared patches.
- Post-apply automatic syntax/test commands based on file type.
- Cleaner rollback from backup when verification fails.
- A final explanation generator that maps each changed file to the user-visible fix.

Why it matters:

- The tool should never silently edit live support files. It should behave like a careful local engineer with backup, diff, approval, verify, and explain steps.

### 4. Deeper WordPress And Directorist Toolkit

Status: initial toolkit implemented.

What remains:

- WP-CLI adapter with safe command allowlist.
- Database read-only checks for post meta, term meta, options, and Directorist builder settings.
- Directorist-specific diagnosis helpers for add-listing forms, geolocation/radius search, booking hours, CSV export fields, single-listing display sections, and review buttons.
- Child-theme surface detection that confirms the active theme and safest edit target before proposing a patch.
- Cache/plugin conflict notes that stay evidence-based instead of guessing.

Why it matters:

- The user's real work is mostly WordPress/Directorist support. Generic browser evidence is useful, but real fixes often require DB/theme/plugin proof.

### 5. Permission And Risk Policy

Status: basic approval gate implemented.

What remains:

- Stronger risk levels for live-site edits, plugin activation/deactivation, database writes, destructive operations, and credential use.
- Policy logs for every blocked or approved action.
- A visible sidebar queue for waiting approvals.
- Separate read-only, prepare-only, and write/apply modes.

Why it matters:

- The assistant needs to protect live sites and avoid doing slow, risky, or destructive work without explicit approval.

### 6. Long-Term Memory And Lessons

Status: evidence/task memory exists; durable learning is early.

What remains:

- A compact site-specific memory store for support cases.
- Retrieval rules that prioritize exact site/plugin/version context.
- Lesson creation only after verified fixes.
- Duplicate/orphan code detection notes.
- Staleness warnings when old memory may no longer match the active site.

Why it matters:

- The tool should remember real fixes without hallucinating that old facts are still current.

### 7. Real Verification Loop

Status: partially implemented.

What remains:

- Automatic verify plan generation after each patch.
- Browser screenshot comparison for responsive/display bugs.
- DOM assertions for required fields, hidden labels, geolocation fields, review buttons, booking widgets, and map cards.
- WordPress admin/public page verification in the same task report.
- A hard rule that FLUID cannot say "fixed" unless verification evidence exists.

Why it matters:

- This is the biggest quality gap between a chatbot and a useful engineering tool.

### 8. Sidebar Product Polish

Status: improved but not complete.

What remains:

- Inline screenshots and artifact links in the task overview.
- Patch preview panel.
- Approval controls.
- Tool/evidence timeline filters.
- Better progress states for waiting, blocked, failed, verified, and applied.
- Compact mobile/sidebar layout testing in the real installed extension.

Why it matters:

- The user needs to see what the tool is doing and why, without opening logs manually.

### 9. Installer And Update Workflow

Status: manual.

What remains:

- One script to install dependencies and start the local bridge.
- One script to verify extension path, bridge health, Python path, and test availability.
- Simple docs for using the same setup on another machine.
- A release/checklist flow before pushing new extension changes.

Why it matters:

- The current setup works for development, but a practical assistant needs a repeatable run path.

### 10. PR-Gated Self Improvement

Status: scaffolded.

What remains:

- Convert repeated failure patterns into eval fixtures.
- Generate patch proposals for planner/tool bugs.
- Run tests automatically.
- Create a branch and PR summary instead of auto-merging.
- Require user review before self-changes are accepted.

Why it matters:

- The tool can improve over time, but self-editing must remain reviewable and reversible.

## Recommended Next Build Order

1. Stabilize existing Chrome/profile attach and extension reload verification.
2. Finish the bridge health/start workflow.
3. Add patch preview and approval controls in the sidebar.
4. Add WordPress/Directorist DB read-only evidence helpers.
5. Add post-fix verification templates for the common support cases.
6. Build the site-specific memory layer.
7. Add installer/update scripts.
8. Expand self-improvement only after eval coverage is reliable.

## Current Practical Readiness

FLUID is now a usable foundation for browser-assisted support investigation and guarded local engineering flows.

Approximate readiness:

- Browser-only help: 70%
- WordPress support investigation: 45%
- Safe local code patching: 45%
- Live-site end-to-end fixing: 30%
- Codex-style autonomous engineering assistant: 40-50%

The highest-impact remaining work is: stable existing-Chrome control, stronger desktop bridge operations, and a fully visible safe patch workflow.
