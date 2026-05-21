@echo off
setlocal
cd /d "%~dp0"
set "DAKSH_DIR=%~dp0"

echo Stopping Daksh services on ports 3001 and 3000...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=(Resolve-Path $env:DAKSH_DIR).Path.TrimEnd('\'); $ports=@(3001,3000); foreach($port in $ports){ $conns=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; foreach($conn in $conns){ $processId=$conn.OwningProcess; $proc=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $processId) -ErrorAction SilentlyContinue; if(-not $proc){ continue }; $cmd=[string]$proc.CommandLine; $name=[string]$proc.Name; $isDakshNode=($name -ieq 'node.exe' -and ($cmd -like '*server.js*' -or $cmd -like ('*' + $root + '*'))); if($isDakshNode){ Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue; Write-Host ('Stopped Daksh process {0} on port {1}' -f $processId,$port) } else { Write-Host ('Skipped PID {0} on port {1} ({2})' -f $processId,$port,$name) } } }; Remove-Item -LiteralPath (Join-Path $root 'server_process.pid') -ErrorAction SilentlyContinue"

echo Done.
endlocal
