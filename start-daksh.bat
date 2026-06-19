@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=3001"
set "APP_URL=http://localhost:%PORT%/force-login"
set "READY_URL=http://127.0.0.1:%PORT%/api/ready"
set "LOG_DIR=%~dp0logs"
set "NODE_LOG=%LOG_DIR%\daksh-node.log"
set "NODE_ERR_LOG=%LOG_DIR%\daksh-node.err.log"
set "NPM_LOG=%LOG_DIR%\npm-install.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

echo Starting Daksh Inventory with PostgreSQL...

call :EnsureNode || goto START_FAILED
call :EnsureEnv || goto START_FAILED
call :EnsureDependencies || goto START_FAILED
call :RunMigrations || goto START_FAILED

call :IsPortListening %PORT%
if "%PORT_ACTIVE%"=="1" (
  echo Daksh service already running.
) else (
  call :StartNode || goto START_FAILED
)

call :WaitForReady || goto START_FAILED
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process '%APP_URL%'" >nul 2>&1
exit /b 0

:START_FAILED
echo Daksh startup failed. Check the logs folder and confirm DATABASE_URL is set.
exit /b 1

:EnsureNode
set "NODE_PATH="
for /f "delims=" %%N in ('where node 2^>nul') do (
  if not defined NODE_PATH set "NODE_PATH=%%N"
)
if not defined NODE_PATH (
  echo ERROR: Node.js not found. Install Node.js first.
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm not found. Reinstall Node.js with npm selected.
  exit /b 1
)
exit /b 0

:EnsureEnv
if not exist ".env" (
  echo PORT=%PORT%>.env
  echo DATABASE_URL=>>.env
  echo JWT_SECRET=daksh_inventory_secret>>.env
  echo DEFAULT_ADMIN_USERNAME=admin>>.env
  echo DEFAULT_ADMIN_PASSWORD=admin>>.env
  echo SMTP_HOST=smtp.gmail.com>>.env
  echo SMTP_PORT=587>>.env
  echo SMTP_USER=>>.env
  echo SMTP_PASS=>>.env
  echo REPORT_EMAIL=amitsvision4u@gmail.com>>.env
)
for /f "tokens=1,* delims==" %%A in (.env) do (
  if /I "%%A"=="DATABASE_URL" set "DATABASE_URL_VALUE=%%B"
)
if "%DATABASE_URL%"=="" if "%DATABASE_URL_VALUE%"=="" (
  echo ERROR: DATABASE_URL is required. Add Railway PostgreSQL DATABASE_URL to .env.
  exit /b 1
)
exit /b 0

:EnsureDependencies
if exist "node_modules" (
  echo node_modules found. Skipping npm install.
  exit /b 0
)
echo node_modules missing. Running npm install once...
call npm install --no-audit --no-fund >> "%NPM_LOG%" 2>&1
if errorlevel 1 (
  echo ERROR: npm install failed. See "%NPM_LOG%".
  exit /b 1
)
exit /b 0

:RunMigrations
echo Running Prisma migrations...
call npm run prisma:migrate >> "%NODE_LOG%" 2>> "%NODE_ERR_LOG%"
if errorlevel 1 (
  echo ERROR: Prisma migration failed. See "%NODE_ERR_LOG%".
  exit /b 1
)
echo Prisma migration completed.
exit /b 0

:IsPortListening
set "PORT_ACTIVE=0"
netstat -ano | findstr :%~1 | findstr /I "LISTENING" >nul 2>&1
if not errorlevel 1 set "PORT_ACTIVE=1"
exit /b 0

:StartNode
echo Starting Daksh backend silently...
if exist "server_process.pid" del "server_process.pid" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$env:DAKSH_MIGRATIONS_COMPLETED='true'; $p=Start-Process -FilePath '%NODE_PATH%' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%NODE_LOG%' -RedirectStandardError '%NODE_ERR_LOG%' -PassThru; Set-Content -LiteralPath '%~dp0server_process.pid' -Value $p.Id" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Daksh backend could not be started.
  exit /b 1
)
exit /b 0

:WaitForReady
set "READY_OK=0"
for /L %%I in (1,1,60) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%READY_URL%' -TimeoutSec 2; exit ([int]($r.StatusCode -ne 200)) } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 (
    set "READY_OK=1"
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)
echo ERROR: Daksh backend did not become ready on port %PORT%.
exit /b 1
