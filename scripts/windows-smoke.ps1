[CmdletBinding()]
param(
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$spaceRoot = Join-Path $repoRoot ".tmp\space path"
$unicodeRoot = Join-Path $repoRoot ".tmp\中文路径"
Push-Location $repoRoot
node.exe scripts/cleanup-smoke-data.mjs | Out-Host
Pop-Location
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

  $toolCall = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/mcp-servers/$($mcp.id)/tools/echo_context/call" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{ arguments = @{ text = "WINAGENT_TOOL_CALL_OK" } } | ConvertTo-Json -Depth 5)
  if ($toolCall.status -ne "completed") {
    throw "MCP tools/call did not complete: $($toolCall.error)"
  }
  $toolCallJson = $toolCall.result | ConvertTo-Json -Depth 10
  if ($toolCallJson -notmatch "WINAGENT_TOOL_CALL_OK") {
    throw "MCP tools/call result did not include expected payload"
  }

  $indexResult = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/workspaces/$($workspace.id)/index" `
    -Method Post
  if ($indexResult.indexed -lt 1) {
    throw "Workspace index did not include smoke files"
  }

  $searchQuery = [System.Uri]::EscapeDataString("Space Path Smoke")
  $searchUri = "http://127.0.0.1:$Port/api/workspaces/$($workspace.id)/search?q=$searchQuery" + "&limit=5"
  $hits = @(Invoke-RestMethod -Uri $searchUri -Method Get)
  if ($hits.Count -lt 1) {
    throw "Workspace retrieval returned no hits"
  }

  $manualMemory = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/workspaces/$($workspace.id)/memories" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{
      type = "preference"
      content = "For smoke validation, preserve the long-term marker WINAGENT_LONG_MEMORY_OK."
    } | ConvertTo-Json)

  $memories = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/workspaces/$($workspace.id)/memories" -Method Get)
  if (-not ($memories | Where-Object { $_.id -eq $manualMemory.id -and $_.content -match "WINAGENT_LONG_MEMORY_OK" })) {
    throw "Long-term memory was not persisted"
  }

  $agent = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/agents" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{
      name = "Smoke PowerShell Agent"
      command = "powershell.exe"
      args = @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "`$prompt = [Console]::In.ReadToEnd(); Write-Output 'Smoke Agent received prompt:'; Write-Output `$prompt; Write-Output 'WINAGENT_DONE'"
      )
      env = @{}
    } | ConvertTo-Json)
  $run = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/runs" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{
      workspaceId = $workspace.id
      agentId = $agent.id
      title = "Windows smoke"
      prompt = "Print WINAGENT_SMOKE_OK"
      retrievalQuery = "Space Path Smoke WINAGENT_LONG_MEMORY_OK"
      timeoutMs = 30000
      maxRetries = 0
      toolCalls = @(@{
          serverId = $mcp.id
          toolName = "echo_context"
          arguments = @{ text = "WINAGENT_TOOL_ASSIST_OK" }
        })
      fileRefs = @((Join-Path $spaceRoot "README.md"))
    } | ConvertTo-Json -Depth 8)

  $runStatus = $null
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    $runs = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs" -Method Get
    $runStatus = @($runs) | Where-Object { $_.id -eq $run.id } | Select-Object -First 1
  } while ($runStatus.status -in @("queued", "running") -and (Get-Date) -lt $deadline)

  if ($runStatus.status -ne "completed") {
    throw "Smoke run did not complete. Status: $($runStatus.status)"
  }

  $events = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs/$($run.id)/events" -Method Get
  $output = ($events | Where-Object { $_.type -eq "run.output.delta" } | ForEach-Object { $_.payload.text }) -join ""
  if ($output -notmatch "WINAGENT_DONE") {
    throw "Expected demo Agent output was not observed"
  }
  if ($output -notmatch "WINAGENT_TOOL_ASSIST_OK") {
    throw "Expected tool-assisted context was not injected into Agent output"
  }
  if ($output -notmatch "WINAGENT_LONG_MEMORY_OK") {
    throw "Expected long-term memory was not injected into Agent output"
  }
  $runToolEvent = $events | Where-Object { $_.type -eq "run.tool.called" } | Select-Object -First 1
  if (-not $runToolEvent) {
    throw "Expected run.tool.called event was not recorded"
  }

  $workingMemory = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs/$($run.id)/working-memory" -Method Get
  if ($workingMemory.content -notmatch "Short-Term Working Memory" -or $workingMemory.content -notmatch "WINAGENT_LONG_MEMORY_OK") {
    throw "Short-term working memory was not built with selected long-term memory"
  }

  $export = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs/$($run.id)/export" -Method Get
  if ($export.markdown -notmatch "Run Report" -or $export.markdown -notmatch $run.id -or $export.markdown -notmatch "Short-Term Working Memory") {
    throw "Run export did not include report metadata and memory"
  }

  $memoriesAfterRun = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/workspaces/$($workspace.id)/memories" -Method Get)
  $runSummaryMemory = $memoriesAfterRun |
    Where-Object { $_.type -eq "run_summary" -and $_.sourceRunId -eq $run.id } |
    Select-Object -First 1
  if (-not $runSummaryMemory) {
    throw "Run outcome was not persisted as long-term memory"
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
    $runs = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs" -Method Get
    $retryStatus = @($runs) | Where-Object { $_.id -eq $retryRun.id } | Select-Object -First 1
  } while ($retryStatus.status -in @("queued", "running") -and (Get-Date) -lt $deadline)

  if ($retryStatus.status -ne "failed" -or $retryStatus.attempt -ne 2) {
    throw "Retry smoke did not fail after retry. Status=$($retryStatus.status), attempt=$($retryStatus.attempt)"
  }

  Write-Host "[ok] Windows smoke passed"
  Write-Host "     workspace: $($workspace.rootPath)"
  Write-Host "     run:       $($run.id)"
  Write-Host "     mcp tool:  echo_context"
  Write-Host "     tool call: $($toolCall.status)"
  Write-Host "     run tool:  $($runToolEvent.payload.toolName)"
  Write-Host "     indexed:   $($indexResult.indexed)"
  Write-Host "     memory:    $($manualMemory.type) + run_summary"
} finally {
  Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
  Push-Location $repoRoot
  node.exe scripts/cleanup-smoke-data.mjs | Out-Host
  Pop-Location
}
