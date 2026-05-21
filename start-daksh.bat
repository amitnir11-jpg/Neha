@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=3001"
set "MONGO_PORT=27017"
set "APP_URL=http://localhost:%PORT%/force-login"
set "HEALTH_URL=http://127.0.0.1:%PORT%/api/health"
set "DBPATH=C:\data\db"
set "LOG_DIR=%~dp0logs"
set "NODE_LOG=%LOG_DIR%\daksh-node.log"
set "NODE_ERR_LOG=%LOG_DIR%\daksh-node.err.log"
set "MONGO_LOG=%LOG_DIR%\mongodb.log"
set "NPM_LOG=%LOG_DIR%\npm-install.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

echo Starting Daksh Inventory services...

call :EnsureNode || goto START_FAILED
call :EnsureEnv
call :EnsureDependencies || goto START_FAILED
call :EnsureMongo || goto START_FAILED

call :IsPortListening %PORT%
if "%PORT_ACTIVE%"=="1" (
  echo Daksh service already running.
  echo Opening application...
) else (
  call :StartNode || goto START_FAILED
)

call :WaitForHealth || goto START_FAILED

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process '%APP_URL%'" >nul 2>&1
exit /b 0

:START_FAILED
echo Daksh startup failed. Check the logs folder.
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
  echo MONGO_URI=mongodb://127.0.0.1:%MONGO_PORT%/daksh_inventory_v2>>.env
  echo JWT_SECRET=daksh_inventory_secret>>.env
  echo SMTP_HOST=smtp.gmail.com>>.env
  echo SMTP_PORT=587>>.env
  echo SMTP_USER=>>.env
  echo SMTP_PASS=>>.env
  echo REPORT_EMAIL=amitsvision4u@gmail.com>>.env
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

:EnsureMongo
call :IsMongoListening
if "%MONGO_ACTIVE%"=="1" (
  echo MongoDB already running.
  exit /b 0
)

if not exist "%DBPATH%" mkdir "%DBPATH%" >nul 2>&1

sc query MongoDB >nul 2>&1
if not errorlevel 1 (
  echo Starting MongoDB service...
  sc start MongoDB >nul 2>&1
  call :WaitForMongo
  if "%MONGO_READY%"=="1" exit /b 0
)

call :FindMongo
if not defined MONGO_PATH (
  echo ERROR: MongoDB was not found on this PC.
  exit /b 1
)

echo Starting MongoDB silently...
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath '%MONGO_PATH%' -ArgumentList @('--dbpath','%DBPATH%','--bind_ip','127.0.0.1','--port','%MONGO_PORT%','--logpath','%MONGO_LOG%','--logappend') -WindowStyle Hidden" >nul 2>&1
if errorlevel 1 (
  echo ERROR: MongoDB could not be started.
  exit /b 1
)

call :WaitForMongo
if not "%MONGO_READY%"=="1" (
  echo ERROR: MongoDB did not become ready.
  exit /b 1
)
exit /b 0

:FindMongo
set "MONGO_PATH="
for /f "delims=" %%M in ('where mongod 2^>nul') do (
  set "MONGO_PATH=%%M"
  goto FindMongoDone
)
for /d %%V in ("C:\Program Files\MongoDB\Server\*") do (
  if exist "%%V\bin\mongod.exe" (
    set "MONGO_PATH=%%V\bin\mongod.exe"
    goto FindMongoDone
  )
)
for /d %%V in ("C:\Program Files (x86)\MongoDB\Server\*") do (
  if exist "%%V\bin\mongod.exe" (
    set "MONGO_PATH=%%V\bin\mongod.exe"
    goto FindMongoDone
  )
)
:FindMongoDone
exit /b 0

:IsPortListening
set "PORT_ACTIVE=0"
netstat -ano | findstr :%~1 | findstr /I "LISTENING" >nul 2>&1
if not errorlevel 1 set "PORT_ACTIVE=1"
exit /b 0

:IsMongoListening
set "MONGO_ACTIVE=0"
netstat -ano | findstr :%MONGO_PORT% | findstr /I "LISTENING" >nul 2>&1
if not errorlevel 1 set "MONGO_ACTIVE=1"
exit /b 0

:WaitForMongo
set "MONGO_READY=0"
for /L %%I in (1,1,30) do (
  call :IsMongoListening
  if "!MONGO_ACTIVE!"=="1" (
    set "MONGO_READY=1"
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)
exit /b 1

:StartNode
echo Starting Daksh backend silently...
if exist "server_process.pid" del "server_process.pid" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$p=Start-Process -FilePath '%NODE_PATH%' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%NODE_LOG%' -RedirectStandardError '%NODE_ERR_LOG%' -PassThru; Set-Content -LiteralPath '%~dp0server_process.pid' -Value $p.Id" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Daksh backend could not be started.
  exit /b 1
)
exit /b 0

:WaitForHealth
set "HEALTH_OK=0"
for /L %%I in (1,1,60) do (
  call :IsPortListening %PORT%
  if "!PORT_ACTIVE!"=="1" (
    set "HEALTH_OK=1"
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)
echo ERROR: Daksh backend did not listen on port %PORT%.
exit /b 1
