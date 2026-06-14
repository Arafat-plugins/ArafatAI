# Browser Agent Node Adapter

This folder is reserved for the existing Node browser-agent MVP.

Current plan:

```text
1. Keep ArafatAI core Python-first.
2. Use Node browser-agent as an external tool adapter.
3. Later add a Python Playwright/CDP version if needed.
```

Current adapter wraps:

```text
C:/Users/Arafat/Local Sites/user-sites/app/public/tools/browser-agent-mvp
```

Python entrypoint:

```bash
python -m arafatai browser-action \
  --url "file:///C:/Users/Arafat/Local Sites/user-sites/app/public/tools/browser-agent-mvp/fixtures/click-test.html" \
  --action "{\"type\":\"click\",\"target\":\"text=Open Modal\"}" \
  --action "{\"type\":\"expect\",\"target\":\"#modal.show\"}" \
  --action "{\"type\":\"screenshot\",\"value\":\"runs/fixture-modal.png\"}" \
  --yes
```
