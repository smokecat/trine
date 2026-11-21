@echo off
rem Restart the trine agent so code changes take effect.
rem
rem Why this script: the agent is started by scheduled task TrineAgent via
rem start-agent.vbs (a one-shot launcher, not a supervisor), so the in-app /
rem web-UI "restart agent" is unavailable (machine.info.restart.available=false).
rem We therefore stop the running bun agent and re-run the task.
rem
rem NOTE: every claude session hosted by this agent is a child of the agent
rem process and will be disconnected. Those sessions can be resumed from the
rem session list afterwards.
rem
rem Usage: double-click it, or run it from an elevated shell. The one-shot
rem scheduled task TrineRestartOnce (if used to launch this) is cleaned up.

setlocal
cd /d "%~dp0"
set LOG=%~dp0restart-agent.log
echo [%DATE% %TIME%] restart requested>>"%LOG%"

echo Stopping trine agent...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -match 'apps[\\/]agent[\\/]src[\\/]cli\.ts' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('  stopped pid ' + $_.ProcessId) }" >>"%LOG%" 2>&1

rem 残留的 control.sock 会让新实例的控制通道起不来（ReparsePoint，普通 rm 删不动）
powershell -NoProfile -Command "Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:USERPROFILE '.trine\control.sock')" >>"%LOG%" 2>&1
timeout /t 2 /nobreak >nul

echo Starting trine agent (scheduled task TrineAgent)...
schtasks /run /tn "TrineAgent" >>"%LOG%" 2>&1
if errorlevel 1 (
  echo   schtasks failed - falling back to start-agent.vbs>>"%LOG%"
  wscript.exe "%~dp0start-agent.vbs"
)

rem 清理一次性重启任务（存在才删）
schtasks /delete /tn "TrineRestartOnce" /f >nul 2>&1

echo [%DATE% %TIME%] restart done>>"%LOG%"
echo Done. Give it a few seconds, then reload the trine web UI.
endlocal
