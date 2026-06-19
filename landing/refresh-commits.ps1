param(
  [int]$Limit = 300
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$commits = git --no-pager log --date=iso-strict --pretty=format:"%H|%ad|%an|%s" -n $Limit | ForEach-Object {
  $parts = $_ -split "\|", 4
  if ($parts.Count -eq 4) {
    [PSCustomObject]@{
      sha = $parts[0]
      date = $parts[1]
      author = $parts[2]
      subject = $parts[3]
    }
  }
}

$json = [PSCustomObject]@{
  generatedAt = (Get-Date).ToString("o")
  repository = "choruzo/CLI"
  branch = (git branch --show-current)
  commits = $commits
}

$outputPath = Join-Path $PSScriptRoot "data\\commits.json"
$json | ConvertTo-Json -Depth 6 | Set-Content -Path $outputPath -Encoding UTF8

$jsOutputPath = Join-Path $PSScriptRoot "data\\commits-data.js"
$jsContent = "window.__STRATUM_COMMITS__ = " + ($json | ConvertTo-Json -Depth 6) + ";"
$jsContent | Set-Content -Path $jsOutputPath -Encoding UTF8

Write-Host "Updated $outputPath and $jsOutputPath with $($commits.Count) commits."
