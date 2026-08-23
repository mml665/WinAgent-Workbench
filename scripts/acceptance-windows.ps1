[CmdletBinding()]
param(
  [int]$BackendPort = 8787,
  [int]$WebPort = 5173,
  [switch]$SkipCodexRun
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$acceptanceRoot = Join-Path $repoRoot ".tmp\acceptance-workspace"
$backendOut = Join-Path $repoRoot ".tmp\acceptance-backend.out.log"
$backendErr = Join-Path $repoRoot ".tmp\acceptance-backend.err.log"
$backend = $null
$web = $null
$checks = New-Object System.Collections.Generic.List[string]

function Add-Check([string]$Name) {
  $checks.Add($Name) | Out-Null
  Write-Host "[ok] $Name"
}

function Stop-ExistingBackend {
  $escapedRepoRoot = [Regex]::Escape($repoRoot)
  $currentPid = $PID
  $portProcesses = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($processId in $portProcesses) {
    if ($processId -ne 0 -and $processId -ne $currentPid) {
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
  }
  $processes = Get-CimInstance Win32_Process |
    Where-Object {
      $_.ProcessId -ne $currentPid -and
      $_.CommandLine -match $escapedRepoRoot -and
      $_.CommandLine -match "src[\\/]backend[\\/]server\.ts"
    }
  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Assert-True([object]$Condition, [string]$Message) {
  $passed = if ($Condition -is [array]) { $Condition.Count -gt 0 } else { [bool]$Condition }
  if (-not $passed) {
    throw $Message
  }
}

function Show-BackendLogs {
  if (Test-Path -LiteralPath $backendOut) {
    Write-Host "[backend stdout]"
    Get-Content -LiteralPath $backendOut -ErrorAction SilentlyContinue | Select-Object -Last 80 | Out-Host
  }
  if (Test-Path -LiteralPath $backendErr) {
    Write-Host "[backend stderr]"
    Get-Content -LiteralPath $backendErr -ErrorAction SilentlyContinue | Select-Object -Last 80 | Out-Host
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
    return Invoke-RestMethod -Uri $uri -Method $Method -DisableKeepAlive -TimeoutSec 30
  }
  return Invoke-RestMethod `
    -Uri $uri `
    -Method $Method `
    -DisableKeepAlive `
    -ContentType "application/json" `
    -Body ($Body | ConvertTo-Json -Depth 12) `
    -TimeoutSec 30
}

function Invoke-ApiArray {
  param(
    [string]$Path,
    [string]$Method = "Get",
    [object]$Body = $null
  )
  return @((Invoke-Api -Path $Path -Method $Method -Body $Body) | ForEach-Object { $_ })
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
    $html = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/" -DisableKeepAlive -UseBasicParsing -TimeoutSec 5
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
  if ($Name -eq "Backend") {
    Show-BackendLogs
  }
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
  Stop-ExistingBackend
  node.exe scripts/cleanup-smoke-data.mjs | Out-Host

  New-Item -ItemType Directory -Force -Path $acceptanceRoot | Out-Null
  Set-Content `
    -LiteralPath (Join-Path $acceptanceRoot "README.md") `
    -Value "# WinAgent Acceptance`n`nMarker: WINAGENT_ACCEPTANCE_CONTEXT" `
    -Encoding utf8

  if (-not (Test-BackendHealthy)) {
    Remove-Item -LiteralPath $backendOut -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backendErr -Force -ErrorAction SilentlyContinue
    $backend = Start-Process `
      -FilePath "node.exe" `
      -ArgumentList @("--import", "tsx", "src/backend/server.ts") `
      -WorkingDirectory $repoRoot `
      -PassThru `
      -WindowStyle Hidden `
      -RedirectStandardOutput $backendOut `
      -RedirectStandardError $backendErr
  }
  Wait-Until -Probe { Test-BackendHealthy } -Name "Backend" -TimeoutSeconds 90
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

  $files = @(Invoke-ApiArray -Path "/api/files?workspaceId=$($workspace.id)")
  Assert-True (@($files | Where-Object { $_.name -eq "README.md" -and $_.kind -eq "file" }).Count -eq 1) "Files API did not list README.md"
  Add-Check "files API"

  $index = Invoke-Api -Path "/api/workspaces/$($workspace.id)/index" -Method "Post"
  Assert-True ($index.indexed -ge 1) "Workspace index did not index acceptance README"
  $hits = @(Invoke-ApiArray -Path "/api/workspaces/$($workspace.id)/search?q=WINAGENT_ACCEPTANCE_CONTEXT&limit=5")
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

  $readiness = @(Invoke-ApiArray -Path "/api/agent-readiness")
  $codexReady = $readiness | Where-Object { $_.id -eq "codex" } | Select-Object -First 1
  Assert-True ($null -ne $codexReady) "Codex readiness record is missing"
  Assert-True ($codexReady.status -eq "ready") "Codex is not ready: $($codexReady.message)"
  Assert-True ($codexReady.supportsStreaming -eq $true) "Codex is not marked streaming-capable"
  Add-Check "agent readiness"

  $adapters = @(Invoke-ApiArray -Path "/api/agent-adapters")
  $codexAdapter = $adapters | Where-Object { $_.id -eq "codex" } | Select-Object -First 1
  Assert-True ($null -ne $codexAdapter) "Codex adapter is missing from adapter registry"
  Assert-True ($codexAdapter.capabilities.streaming -eq $true) "Codex adapter does not declare streaming capability"
  Assert-True ($codexAdapter.defaultArgs -contains "exec") "Codex adapter does not declare exec default args"
  Add-Check "agent adapter registry"

  $migrations = @(Invoke-ApiArray -Path "/api/schema-migrations")
  Assert-True (@($migrations | Where-Object { $_.id -eq "0001_initial_runtime_schema" }).Count -eq 1) "Initial schema migration is missing"
  Assert-True (@($migrations | Where-Object { $_.id -eq "0002_agent_adapters_settings_artifacts" }).Count -eq 1) "Adapter/settings/artifacts schema migration is missing"
  Assert-True (@($migrations | Where-Object { $_.id -eq "0003_tasks_approvals_references" }).Count -eq 1) "Tasks/approvals/references schema migration is missing"
  Add-Check "schema migrations"

  $setting = Invoke-Api `
    -Path "/api/settings" `
    -Method "Post" `
    -Body @{
      key = "acceptance.lastRun"
      value = @{
        marker = "WINAGENT_ACCEPTANCE_CONTEXT"
      }
    }
  Assert-True ($setting.key -eq "acceptance.lastRun") "Setting write did not return expected key"
  $settings = @(Invoke-ApiArray -Path "/api/settings")
  Assert-True (@($settings | Where-Object { $_.key -eq "acceptance.lastRun" }).Count -eq 1) "Setting was not persisted"
  Add-Check "settings persistence"

  $agents = @(Invoke-ApiArray -Path "/api/agents")
  $codexAgent = $agents | Where-Object { $_.name -eq "Codex" } | Select-Object -First 1
  Assert-True ($null -ne $codexAgent) "Codex runnable profile is missing"
  Assert-True ($codexAgent.adapterId -eq "codex") "Codex profile is not linked to the codex adapter"
  Assert-True ($codexAgent.enabled -eq $true) "Codex profile is not enabled"
  Assert-True (@($agents | Where-Object { $_.name -match "Demo|Smoke|Fail once" }).Count -eq 0) "Demo/smoke Agent profiles leaked into product data"
  Add-Check "agent profiles clean"

  $mcpServers = @(Invoke-ApiArray -Path "/api/mcp-servers")
  Assert-True (@($mcpServers | Where-Object { $_.name -eq "Smoke MCP" }).Count -eq 0) "Smoke MCP leaked into product data"
  Add-Check "mcp data clean"

  $task = Invoke-Api `
    -Path "/api/workspaces/$($workspace.id)/tasks" `
    -Method "Post" `
    -Body @{
      title = "Acceptance task"
      description = "Task marker WINAGENT_ACCEPTANCE_CONTEXT"
      priority = "normal"
    }
  Assert-True ($task.title -eq "Acceptance task") "Task Center did not create the expected task"
  Assert-True ($task.status -eq "todo") "New task did not start in todo status"
  $tasks = @(Invoke-ApiArray -Path "/api/workspaces/$($workspace.id)/tasks")
  Assert-True (@($tasks | Where-Object { $_.id -eq $task.id }).Count -eq 1) "Task Center did not list the created task"
  $taskReview = Invoke-Api -Path "/api/tasks/$($task.id)/status" -Method "Post" -Body @{ status = "review" }
  Assert-True ($taskReview.status -eq "review") "Task Center did not update task status"
  Add-Check "task center"

  $approval = Invoke-Api `
    -Path "/api/workspaces/$($workspace.id)/approvals" `
    -Method "Post" `
    -Body @{
      kind = "task_review"
      title = "Acceptance approval"
      description = "Approve acceptance task"
      metadata = @{
        taskId = $task.id
        marker = "WINAGENT_ACCEPTANCE_CONTEXT"
      }
    }
  Assert-True ($approval.status -eq "pending") "Approval Center did not create a pending approval"
  $approvals = @(Invoke-ApiArray -Path "/api/workspaces/$($workspace.id)/approvals")
  Assert-True (@($approvals | Where-Object { $_.id -eq $approval.id }).Count -eq 1) "Approval Center did not list the created approval"
  $approved = Invoke-Api -Path "/api/approvals/$($approval.id)/decision" -Method "Post" -Body @{ status = "approved" }
  Assert-True ($approved.status -eq "approved") "Approval Center did not persist the approval decision"
  Add-Check "approval center"

  $reference = Invoke-Api `
    -Path "/api/workspaces/$($workspace.id)/references" `
    -Method "Post" `
    -Body @{
      kind = "task"
      targetId = $task.id
      label = "Acceptance task reference"
      summary = "Reusable task reference WINAGENT_ACCEPTANCE_CONTEXT"
      metadata = @{
        taskId = $task.id
      }
    }
  Assert-True ($reference.kind -eq "task") "Reference Picker did not create a task reference"
  $references = @(Invoke-ApiArray -Path "/api/workspaces/$($workspace.id)/references")
  Assert-True (@($references | Where-Object { $_.id -eq $reference.id }).Count -eq 1) "Reference Picker did not list the created reference"
  Add-Check "workspace references"

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
    Assert-True ($run.prompt -eq "Do not edit files. Reply with exactly: WINAGENT_ACCEPTANCE_OK") "Acceptance run was created with the wrong prompt"

    $deadline = (Get-Date).AddSeconds(180)
    $runStatus = $null
    do {
      Start-Sleep -Seconds 3
      $runStatus = Invoke-Api -Path "/api/runs/$($run.id)"
    } while ($runStatus.status -in @("queued", "running") -and (Get-Date) -lt $deadline)

    $summary = ([string]$runStatus.summary).Trim()
    Assert-True ($runStatus.status -eq "completed") "Codex acceptance run did not complete. Status=$($runStatus.status), summary=$summary"
    Assert-True ($summary -eq "WINAGENT_ACCEPTANCE_OK") "Codex acceptance summary was not the expected marker. Summary=$summary"

    $output = ""
    $eventDeadline = (Get-Date).AddSeconds(12)
    do {
      $events = @(Invoke-ApiArray -Path "/api/runs/$($run.id)/events")
      $output = $events | ConvertTo-Json -Depth 20
      if ($output -match "WINAGENT_ACCEPTANCE_OK") {
        break
      }
      Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $eventDeadline)
    Assert-True ($output -match "WINAGENT_ACCEPTANCE_OK") "Codex acceptance output did not contain expected marker"

    $workingMemory = Invoke-Api -Path "/api/runs/$($run.id)/working-memory"
    Assert-True ($workingMemory.content -match "WINAGENT_ACCEPTANCE_CONTEXT") "Working memory did not include retrieved acceptance context"

    $runArtifacts = @(Invoke-ApiArray -Path "/api/runs/$($run.id)/artifacts")
    Assert-True ($runArtifacts.Count -ge 1) "Run did not create an execution artifact"
    $workspaceArtifacts = @(Invoke-ApiArray -Path "/api/workspaces/$($workspace.id)/artifacts")
    Assert-True (@($workspaceArtifacts | Where-Object { $_.runId -eq $run.id }).Count -ge 1) "Workspace artifacts did not include the completed run artifact"
    $artifactReferences = @(Invoke-ApiArray -Path "/api/workspaces/$($workspace.id)/references")
    Assert-True (@($artifactReferences | Where-Object { $_.kind -eq "artifact" -and $_.metadata.runId -eq $run.id }).Count -ge 1) "Completed run artifact was not registered as a workspace reference"
    Add-Check "run artifacts and references"
    Add-Check "real Codex Agent run"
  }

  Write-Host "[ok] Acceptance passed with $($checks.Count) checks"
} finally {
  if ($backend -and -not $backend.HasExited) {
    Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
  }
  Stop-ExistingBackend
  if ($web -and -not $web.HasExited) {
    Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue
  }
  node.exe scripts/cleanup-smoke-data.mjs | Out-Host
  Pop-Location
}
