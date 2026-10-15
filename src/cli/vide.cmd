@echo off
rem vide CLI shim (PLAN-52 T-315). Installed as app\bin\vide.cmd next to app\src\cli\vide.ts; the
rem bundled Node is ..\..\runtime\node.exe. In the repository (src\cli\vide.cmd) it uses node on PATH.
setlocal
set "VIDE_CLI=%~dp0vide.ts"
if not exist "%VIDE_CLI%" set "VIDE_CLI=%~dp0..\src\cli\vide.ts"
set "VIDE_NODE=node"
if exist "%~dp0..\..\runtime\node.exe" set "VIDE_NODE=%~dp0..\..\runtime\node.exe"
"%VIDE_NODE%" "%VIDE_CLI%" %*
exit /b %ERRORLEVEL%
