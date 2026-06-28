# Evals

Evaluation keeps agent improvement honest.

Initial scorecards:

```text
browser fixture opens
real click works
action log exists
screenshot exists
risky action requires approval
tests pass before PR
```

## Support Case Fixtures

Real support failures are stored as JSON fixtures under `support_cases/`.

Current file:

```text
support_cases/directorist-support-cases.json
```

Each case records the user-style goal, page context, expected task
classification, and evidence gates that must be collected before FLUID can
claim a fix. Add a new case whenever a real task fails or FLUID takes the wrong
route.

The Node bridge regression test is:

```powershell
npm.cmd test --prefix tools/sidebar-bridge-node -- test/support-cases.test.mjs
```
