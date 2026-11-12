@echo off
rem DS Launchpad launcher - ASCII only (cmd reads this in the OEM codepage)
setlocal
set "ROOT=%~dp0.."
rem Clear ELECTRON_RUN_AS_NODE (the DSH shell sets it for child processes)
set "ELECTRON_RUN_AS_NODE="
cd /d "%ROOT%"
if not exist "%ROOT%\node_modules\electron\dist\electron.exe" (
  echo [DS Launchpad] electron.exe not found. Run: npm install
  pause
  exit /b 1
)
start "" "%ROOT%\node_modules\electron\dist\electron.exe" "%ROOT%" --no-sandbox %*
exit /b 0
