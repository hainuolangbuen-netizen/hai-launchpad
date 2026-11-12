@echo off
rem Dev launcher for DS-Launchpad inside the DSH agent sandbox.
rem - clears ELECTRON_RUN_AS_NODE (DSH sets it for its own children)
rem - --no-sandbox: Chromium sandbox cannot initialize inside this agent session
rem - --user-data-dir: profile must live inside the workspace; writes outside are denied
setlocal
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0.."
set "UD=%~dp0..\work\ud"
if not exist "%UD%" mkdir "%UD%"
"%~dp0..\node_modules\electron\dist\electron.exe" . --no-sandbox --user-data-dir="%UD%" --show %*
