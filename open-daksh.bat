@echo off
setlocal
cd /d "%~dp0"
set "DAKSH_PORT=3001"

if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="PORT" if not "%%B"=="" set "DAKSH_PORT=%%B"
  )
)

if exist "server_port.txt" (
  for /f "usebackq delims=" %%P in ("server_port.txt") do (
    if not "%%P"=="" set "DAKSH_PORT=%%P"
  )
)

set "APP_URL=http://localhost:%DAKSH_PORT%/force-login"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process '%APP_URL%'" >nul 2>&1
if errorlevel 1 start "" "%APP_URL%"
endlocal
