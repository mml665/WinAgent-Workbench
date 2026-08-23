[CmdletBinding()]
param(
  [int]$BackendPort = 8787,
  [int]$WebPort = 5173,
  [switch]$SkipCodexRun
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$acceptanceRoot = Join-Path $repoRoot ".tmp\acceptance-workspace"
$backend = $null
$web = $null
$checks = New-Object System.Collections.Generic.List[string]

function Add-Check([string]$Name) {
  $checks.Add($Name) | Out-Null
  Write-Host "[ok] $Name"
}

function Assert-True([object]$Condition, [string]$Message) {
  $passed = if ($Condition -is [array]) { $Condition.Count -gt 0 } else { [bool]$Condition }
  if (-not $passed) {
    throw $Message
  }
}

function Invoke-Api {
  param(
    [string]$Path,
    [string]$Method = "Get",
    [object]$Body = $null
  )
  $uri = "http://127.0.0.1:$BackendPort$Path"
  if ($null -eq $Body) {
    return Invoke-RestMethod -Uri $uri -Method $Method -TimeoutSec 30
  }
  return Invoke-RestMethod `
    -Uri $uri `
    -Method $Method `
    -ContentType "application/json" `
    -Body ($Body | ConvertTo-Json -Depth 12) `
    -TimeoutSec 30
}

function Test-BackendHealthy {
  try {
    $health = Invoke-Api -Path "/api/health"
    return [bool]$health.ok
  } catch {
    return $false
  }
}

function Test-WebReady {
  try {
    $html = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/" -UseBasicParsing -TimeoutSec 5
    return ($html.StatusCode -eq 200 -and $html.Content -match 'id="root"')
  } catch {
    return $false
  }
}

function Wait-Until {
  param(
    [scriptblock]$Probe,
    [string]$Name,
    [int]$TimeoutSeconds = 30
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (& $Probe) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "$Name did not become ready in $TimeoutSeconds seconds"
}

function Get-RunEventText([object[]]$Events) {
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($event in $Events) {
    if ($event.type -notin @("run.output.delta", "run.error.delta")) {
      continue
    }
    $textProperty = $event.payload.PSObject.Properties["text"]
    if ($textProperty) {
      $parts.Add([string]$textProperty.Value) | Out-Null
    } else {
      $parts.Add(($event.payload | ConvertTo-Json -Depth 8)) | Out-Null
    }
  }
  return ($parts -join "")
}

Push-Location $repoRoot
try {
  node.exe scripts/cleanup-smoke-data.mjs | Out-Host

  New-Item -ItemType Directory -Force -Path $acceptanceRoot | Out-Null
  Set-Content `
    -LiteralPath (Join-Path $acceptanceRoot "README.md") `
    -Value "# WinAgent Acceptance`n`nMarker: WINAGENT_ACCEPTANCE_CONTEXT" `
    -Encoding utf8

  if (-not (Test-BackendHealthy)) {
    $backend = Start-Process `
      -FilePath "node.exe" `
      -ArgumentList @("--import", "tsx", "src/backend/server.ts") `
      -WorkingDirectory $repoRoot `
      -PassThru `
      -WindowStyle Hidden
  }
  Wait-Until -Probe { Test-BackendHealthy } -Name "Backend" -TimeoutSeconds 30
  Add-Check "backend health"

  if (-not (Test-WebReady)) {
    $web = Start-Process `
      -FilePath "npm.cmd" `
      -ArgumentList @("run", "dev:web", "--", "--port", "$WebPort") `
      -WorkingDirectory $repoRoot `
      -PassThru `
      -WindowStyle Hidden
  }
  Wait-Until -Probe { Test-WebReady } -Name "Frontend" -TimeoutSeconds 45
  Add-Check "frontend dev page"

  $workspace = Invoke-Api -Path "/api/workspaces" -Method "Post" -Body @{ rootPath = $acceptanceRoot }
  Assert-True ($workspace.rootPath -eq $acceptanceRoot) "Workspace did not open at expected path"
  Add-Check "workspace open"

  $files = @(Invoke-Api -Path "/api/files?workspaceId=$($workspace.id)")
  Assert-True (($files | Where-Object { $_.name -eq "README.md" -and $_.kind -eq "file" }).Count -eq 1) "Files API did not list README.md"
  Add-Check "files API"

  $index = Invoke-Api -Path "/api/workspaces/$($workspace.id)/index" -Method "Post"
  Assert-True ($index.indexed -ge 1) "Workspace index did not index acceptance README"
  $hits = @(Invoke-Api -Path "/api/workspaces/$($workspace.id)/search?q=WINAGENT_ACCEPTANCE_CONTEXT&limit=5")
  Assert-True ($hits.Count -ge 1) "Workspace search did not return acceptance marker"
  Add-Check "workspace index and search"

  $memory = Invoke-Api `
    -Path "/api/workspaces/$($workspace.id)/memories" `
    -Method "Post" `
    -Body @{
      type = "preference"
      content = "Acceptance memory marker WINAGENT_ACCEPTANCE_CONTEXT must be visible to runs."
    }
  Assert-True ($memory.content -match "WINAGENT_ACCEPTANCE_CONTEXT") "Workspace memory was not persisted"
  Add-Check "long-term memory write"

  $readiness = @(Invoke-Api -Path "/api/agent-readiness")
  $codexReady = $readiness | Where-Object { $_.id -eq "codex" } | Select-Object -First 1
  Assert-True ($null -ne $codexReady) "Codex readiness record is missing"
  Assert-True ($codexReady.status -eq "ready") "Codex is not ready: $($codexReady.message)"
  Assert-True ($codexReady.supportsStreaming -eq $true) "Codex is not marked streaming-capable"
  Add-Check "agent readiness"

  $agents = @(Invoke-Api -Path "/api/agents")
  $codexAgent = $agents | Where-Object { $_.name -eq "Codex" } | Select-Object -First 1
  Assert-True ($null -ne $codexAgent) "Codex runnable profile is missing"
  Assert-True (($agents | Where-Object { $_.name -match "Demo|Smoke|Fail once" }).Count -eq 0) "Demo/smoke Agent profiles leaked into product data"
  Add-Check "agent profiles clean"

  $mcpServers = @(Invoke-Api -Path "/api/mcp-servers")
  Assert-True (($mcpServers | Where-Object { $_.name -eq "Smoke MCP" }).Count -eq 0) "Smoke MCP leaked into product data"
  Add-Check "mcp data clean"

  if (-not $SkipCodexRun) {
    $run = Invoke-Api `
      -Path "/api/runs" `
      -Method "Post" `
      -Body @{
        workspaceId = $workspace.id
        agentId = $codexAgent.id
        title = "Acceptance Codex Agent"
        prompt = "Do not edit files. Reply with exactly: WINAGENT_ACCEPTANCE_OK"
        retrievalQuery = "WINAGENT_ACCEPTANCE_CONTEXT"
        timeoutMs = 180000
        maxRetries = 0
        fileRefs = @((Join-Path $acceptanceRoot "README.md"))
        toolCalls = @()
      }

    $deadline = (Get-Date).AddSeconds(180)
    $runStatus = $null
    do {
      Start-Sleep -Seconds 3
      $runs = @(Invoke-Api -Path "/api/runs")
      $runStatus = $runs | Where-Object { $_.id -eq $run.id } | Select-Object -First 1
    } while ($runStatus.status -in @("queued", "running") -and (Get-Date) -lt $deadline)

    $summary = ([string]$runStatus.summary).Trim()
    Assert-True ($runStatus.status -eq "completed") "Codex acceptance run did not complete. Status=$($runStatus.status), summary=$summary"
    Assert-True ($summary -eq "WINAGENT_ACCEPTANCE_OK") "Codex acceptance summary was not the expected marker. Summary=$summary"

    $output = ""
    $eventDeadline = (Get-Date).AddSeconds(12)
    do {
      $events = @(Invoke-Api -Path "/api/runs/$($run.id)/events")
      $output = $events | ConvertTo-Json -Depth 20
      if ($output -match "WINAGENT_ACCEPTANCE_OK") {
        break
      }
      Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $eventDeadline)
    Assert-True ($output -match "WINAGENT_ACCEPTANCE_OK") "Codex acceptance output did not contain expected marker"

    $workingMemory = Invoke-Api -Path "/api/runs/$($run.id)/working-memory"
    Assert-True ($workingMemory.content -match "WINAGENT_ACCEPTANCE_CONTEXT") "Working memory did not include retrieved acceptance context"
    Add-Check "real Codex Agent run"
  }

  Write-Host "[ok] Acceptance passed with $($checks.Count) checks"
} finally {
  if ($backend -and -not $backend.HasExited) {
    Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
  }
  if ($web -and -not $web.HasExited) {
    Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue
  }
  node.exe scripts/cleanup-smoke-data.mjs | Out-Host
  Pop-Location
}
