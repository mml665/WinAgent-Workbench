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

  $agents = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/agents" -Method Get
  $run = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/runs" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{
      workspaceId = $workspace.id
      agentId = $agents[0].id
      title = "Windows smoke"
      prompt = "Print WINAGENT_SMOKE_OK"
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

  Write-Host "[ok] Windows smoke passed"
  Write-Host "     workspace: $($workspace.rootPath)"
  Write-Host "     run:       $($run.id)"
} finally {
  Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
}
