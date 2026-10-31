@echo off
rem Memory Galaxy - local read-only static server for dsh-deep-memory.
rem Double-click this file. Close the window to stop the server.
cd /d "%~dp0"

if not exist "data.json" (
  echo [1/2] exporting memory data ...
  node "..\scripts\viz-export.mjs"
)

rem open the browser two seconds later, so the server is ready first
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8080'"

echo.
echo   Memory Galaxy  ->  http://127.0.0.1:8080
echo   Data file      ->  %~dp0data.json
echo.
echo   Close this window to stop the server.
echo.

node serve.mjs 8080
