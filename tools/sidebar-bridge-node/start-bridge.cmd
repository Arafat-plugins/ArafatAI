@echo off
setlocal
cd /d "%~dp0..\.."
node tools\sidebar-bridge-node\src\server.mjs --port 8792 --token arafatai-local-token --cwd "%cd%" --provider codex --timeout 120
pause
