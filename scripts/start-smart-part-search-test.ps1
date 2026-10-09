$taskWorkspace = (Get-Location).Path
$taskSessionPath = Join-Path $taskWorkspace '.codex-artifacts/smart-part-search/session.json'
$taskSession = Get-Content -LiteralPath $taskSessionPath -Raw | ConvertFrom-Json
if ($taskSession.origin -ne 'http://127.0.0.1:55441') { throw 'Only the isolated local testing session is allowed' }
$taskRoot = Join-Path $taskWorkspace '.codex-artifacts/smart-part-search'
$env:DATABASE_URL = 'postgresql://scan_test@127.0.0.1:55438/scan_acceptance'
$env:JWT_SECRET = $taskSession.secret
$env:PORT = [string]$taskSession.port
$env:HOST = '0.0.0.0'
$env:NODE_ENV = 'test'
$env:DAKSH_LICENSE_REQUIRED = 'false'
$env:MDNS_ENABLED = 'false'
$env:MOBILE_DISCOVERY_ENABLED = 'false'
$env:DAKSH_DATA_ROOT = Join-Path $taskRoot 'runtime'
$taskProcess = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $taskWorkspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot 'preview-server.log') -RedirectStandardError (Join-Path $taskRoot 'preview-server-error.log') -PassThru
$taskSession.pid = $taskProcess.Id
$taskSession | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $taskSessionPath
[pscustomobject]@{Pid=$taskProcess.Id; Url=$taskSession.origin}
