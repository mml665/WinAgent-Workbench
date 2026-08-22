[CmdletBinding()]
param(
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$spaceRoot = Join-Path $repoRoot ".tmp\space path"
$unicodeRoot = Join-Path $repoRoot ".tmp\中文路径"
New-Item -ItemType Directory -Force -Path $spaceRoot | Out-Null
New-Item -ItemType Directory -Force -Path $unicodeRoot | Out-Null
Set-Content -LiteralPath (Join-Path $spaceRoot "README.md") -Value "# Space Path Smoke" -Encoding utf8
Set-Content -LiteralPath (Join-Path $unicodeRoot "README.md") -Value "# Unicode Path Smoke" -Encoding utf8

$backend = Start-Process -FilePath "node.exe" `
  -ArgumentList @("--import", "tsx", "src/backend/server.ts") `
  -WorkingDirectory $repoRoot `
  -PassThru `
  -WindowStyle Hidden

try {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -Method Get -TimeoutSec 2
      if ($health.ok) { break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)

  if (-not $health.ok) {
    throw "Backend did not become healthy"
  }

  $workspace = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/workspaces" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{ rootPath = $spaceRoot } | ConvertTo-Json)

  $mcp = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/mcp-servers" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{
      name = "Smoke MCP"
      command = "node.exe"
      args = @("tools/mock-mcp-server.mjs")
      env = @{}
    } | ConvertTo-Json)

  $mcpStarted = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/mcp-servers/$($mcp.id)/start" `
    -Method Post
  if ($mcpStarted.status -ne "running") {
    throw "MCP server did not start: $($mcpStarted.lastError)"
  }

  $tools = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/mcp-tools?serverId=$($mcp.id)" -Method Get)
  if (-not ($tools | Where-Object { $_.name -eq "echo_context" })) {
    throw "MCP tools/list did not persist echo_context"
  }

  $indexResult = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/workspaces/$($workspace.id)/index" `
    -Method Post
  if ($indexResult.indexed -lt 1) {
    throw "Workspace index did not include smoke files"
  }

  $hits = @(Invoke-RestMethod `
      -Uri "http://127.0.0.1:$Port/api/workspaces/$($workspace.id)/search?q=Space%20Path%20Smoke&limit=5" `
      -Method Get)
  if ($hits.Count -lt 1) {
    throw "Workspace retrieval returned no hits"
  }

  $agents = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/agents" -Method Get)
  $run = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/runs" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{
      workspaceId = $workspace.id
      agentId = $agents[0].id
      title = "Windows smoke"
      prompt = "Print WINAGENT_SMOKE_OK"
      retrievalQuery = "Space Path Smoke"
      timeoutMs = 30000
      maxRetries = 0
      fileRefs = @((Join-Path $spaceRoot "README.md"))
    } | ConvertTo-Json)

  $runStatus = $null
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    $runs = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs" -Method Get
    $runStatus = ($runs | Where-Object { $_.id -eq $run.id })[0]
  } while ($runStatus.status -in @("queued", "running") -and (Get-Date) -lt $deadline)

  if ($runStatus.status -ne "completed") {
    throw "Smoke run did not complete. Status: $($runStatus.status)"
  }

  $events = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs/$($run.id)/events" -Method Get
  $output = ($events | Where-Object { $_.type -eq "run.output.delta" } | ForEach-Object { $_.payload.text }) -join ""
  if ($output -notmatch "WINAGENT_DONE") {
    throw "Expected demo Agent output was not observed"
  }

  $failingAgent = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/agents" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{
      name = "Fail once smoke"
      command = "powershell.exe"
      args = @("-NoProfile", "-Command", "Write-Error 'retry smoke failure'; exit 9")
      env = @{}
    } | ConvertTo-Json)

  $retryRun = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/runs" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{
      workspaceId = $workspace.id
      agentId = $failingAgent.id
      title = "Retry smoke"
      prompt = "fail"
      timeoutMs = 10000
      maxRetries = 1
      fileRefs = @()
    } | ConvertTo-Json)

  $retryStatus = $null
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 500
    $runs = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs" -Method Get)
    $retryStatus = ($runs | Where-Object { $_.id -eq $retryRun.id })[0]
  } while ($retryStatus.status -in @("queued", "running") -and (Get-Date) -lt $deadline)

  if ($retryStatus.status -ne "failed" -or $retryStatus.attempt -ne 2) {
    throw "Retry smoke did not fail after retry. Status=$($retryStatus.status), attempt=$($retryStatus.attempt)"
  }

  Write-Host "[ok] Windows smoke passed"
  Write-Host "     workspace: $($workspace.rootPath)"
  Write-Host "     run:       $($run.id)"
  Write-Host "     mcp tool:  echo_context"
  Write-Host "     indexed:   $($indexResult.indexed)"
} finally {
  Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
}
