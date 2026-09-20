@echo off
rem ===========================================================
rem  Live Interpreter - portable launcher
rem  ASCII ONLY - NO BOM - NO CJK. Keep it that way:
rem  cmd.exe parses this file with the OEM codepage (GBK on zh-CN),
rem  so any UTF-8 multibyte text here gets shredded into broken
rem  commands ("'em' is not recognized ...").
rem  All Chinese user-facing text is printed by Node instead.
rem
rem  Works from ANY folder / any drive. No install, no admin.
rem
rem  Node lookup order:
rem    1) bundled portable runtime   runtime\node\node.exe
rem    2) the runtime folder itself  runtime\node.exe
rem    3) Node already installed on this machine (PATH)
rem    4) ask the PowerShell helper to download a portable runtime
rem ===========================================================
setlocal EnableExtensions
cd /d "%~dp0"
title Live Interpreter

set "NODE_EXE="

if exist "runtime\node\node.exe" set "NODE_EXE=%CD%\runtime\node\node.exe"
if not defined NODE_EXE if exist "runtime\node.exe" set "NODE_EXE=%CD%\runtime\node.exe"

if not defined NODE_EXE (
  for /f "delims=" %%p in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%p"
  )
)

if not defined NODE_EXE goto SETUP

:HAVENODE
echo.
echo   Live Interpreter
for /f "delims=" %%v in ('"%NODE_EXE%" -v') do echo   Node.js %%v
echo   Runtime: %NODE_EXE%
echo   Folder : %CD%
echo   Starting local server, a free port is chosen automatically.
echo   The browser will open by itself. Press Ctrl+C to stop.
echo.

rem LI_PORT is reserved for automated tests: fixed port, no browser launch
if defined LI_PORT (
  "%NODE_EXE%" proxy-boot.mjs --port %LI_PORT%
) else (
  "%NODE_EXE%" proxy-boot.mjs --open
)
set "EXITCODE=%errorlevel%"
if not "%EXITCODE%"=="0" goto FAILED
goto DONE

:SETUP
rem Node is missing: run the helper hidden and show a friendly popup.
set "VBS=%TEMP%\li-setup-%RANDOM%.vbs"
> "%VBS%" echo Set s = CreateObject("WScript.Shell")
>> "%VBS%" echo r = s.Run("powershell -NoProfile -ExecutionPolicy Bypass -File ""%~dp0setup-node.ps1""", 0, True)
>> "%VBS%" echo If r = 0 Then
>> "%VBS%" echo   MsgBox "Node.js runtime is ready." ^& vbCrLf ^& vbCrLf ^& "Click OK to start Live Interpreter.", 64, "Live Interpreter"
>> "%VBS%" echo Else
>> "%VBS%" echo   MsgBox "Could not prepare the Node.js runtime." ^& vbCrLf ^& vbCrLf ^& "Please install the LTS build from https://nodejs.org and run this launcher again.", 16, "Live Interpreter"
>> "%VBS%" echo End If
cscript //nologo "%VBS%"
del "%VBS%" >nul 2>nul

if exist "runtime\node\node.exe" set "NODE_EXE=%CD%\runtime\node\node.exe"
if not defined NODE_EXE if exist "runtime\node.exe" set "NODE_EXE=%CD%\runtime\node.exe"
if defined NODE_EXE goto HAVENODE

echo.
echo   [X] Node.js is still not available.
echo       Install the LTS build from https://nodejs.org and try again.
echo.
pause
goto DONE

:FAILED
echo.
echo   [!] Server exited with code %EXITCODE%
echo   [!] Keep this file next to proxy-boot.mjs and server.mjs.
echo.
pause

:DONE
endlocal
