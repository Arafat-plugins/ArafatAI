# Browser Agent Node Adapter

This is the browser hand for ArafatAI. The AI core stays Python-first, while
this tool uses Chrome DevTools Protocol for real browser actions.

It supports:

```text
real coordinate click
type
upload
expect
screenshot
snapshot JSON
risky-action confirmation
```

Install once:

```bash
npm install
```

Direct Node smoke tests:

```bash
npm run test:fixture
npm run test:snapshot
```

Python entrypoints:

```bash
python -m arafatai browser-action \
  --url "file:///C:/Users/Arafat/Documents/ArafatAI/tools/browser-agent-node/fixtures/click-test.html" \
  --actions-file examples/browser-actions/fixture-modal.json \
  --yes

python -m arafatai browser-snapshot \
  --url "file:///C:/Users/Arafat/Documents/ArafatAI/tools/browser-agent-node/fixtures/click-test.html" \
  --output runs/fixture-snapshot.json
```

Override the browser tool path with `ARAFATAI_BROWSER_AGENT_NODE` when needed.
