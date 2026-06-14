# Local Setup On Windows

This project uses a Python-first core.

For this machine, Python was installed on the D drive:

```text
D:\ArafatTools\Python313
```

Project virtual environment:

```text
D:\ArafatTools\venvs\ArafatAI
```

## Install

```powershell
& 'D:\ArafatTools\Python313\python.exe' -m venv 'D:\ArafatTools\venvs\ArafatAI'
& 'D:\ArafatTools\venvs\ArafatAI\Scripts\python.exe' -m pip install --upgrade pip
& 'D:\ArafatTools\venvs\ArafatAI\Scripts\python.exe' -m pip install -e '.[dev]'
```

## Test

```powershell
& 'D:\ArafatTools\venvs\ArafatAI\Scripts\python.exe' -m pytest -q
```

## CLI Smoke Test

```powershell
& 'D:\ArafatTools\venvs\ArafatAI\Scripts\python.exe' -m arafatai --help
& 'D:\ArafatTools\venvs\ArafatAI\Scripts\python.exe' -m arafatai plan --goal "test browser agent"
```

## Browser Fixture Test

Use `--actions-file` on PowerShell to avoid JSON quote escaping issues.

```powershell
$fixture = 'file:///C:/Users/Arafat/Local%20Sites/user-sites/app/public/tools/browser-agent-mvp/fixtures/click-test.html'

& 'D:\ArafatTools\venvs\ArafatAI\Scripts\python.exe' -m arafatai browser-action `
  --url $fixture `
  --actions-file examples/browser-actions/fixture-modal.json `
  --yes
```

Expected:

```text
"ok": true
clicked: text=Open Modal
expect passed: #modal.show
```
