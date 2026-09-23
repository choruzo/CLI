param(
  [int]$Limit = 500
)

# Regenera data/commits.json y data/commits-data.js a partir del repo local:
# commits (con líneas +/-), tags de release y, si `gh` está disponible, PRs.
# La landing usa este snapshot como respaldo cuando la API de GitHub no responde.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

# --- Commits con shortstat --------------------------------------------------
$raw = git --no-pager log --date=iso-strict --shortstat --pretty=format:"@@%H|%ad|%an|%s" -n $Limit
$commits = New-Object System.Collections.Generic.List[object]
$current = $null
foreach ($line in $raw) {
  if ($line.StartsWith("@@")) {
    $parts = $line.Substring(2) -split "\|", 4
    if ($parts.Count -eq 4) {
      $current = [ordered]@{ sha = $parts[0]; date = $parts[1]; author = $parts[2]; subject = $parts[3]; add = 0; del = 0; files = 0 }
      $commits.Add($current)
    }
  } elseif ($current -and $line -match "files? changed") {
    if ($line -match "(\d+) files? changed") { $current.files = [int]$Matches[1] }
    if ($line -match "(\d+) insertions?") { $current.add = [int]$Matches[1] }
    if ($line -match "(\d+) deletions?") { $current.del = [int]$Matches[1] }
  }
}

# --- Releases (tags) --------------------------------------------------------
$tags = git --no-pager tag --sort=-creatordate --format="%(refname:short)|%(creatordate:iso-strict)" | ForEach-Object {
  $p = $_ -split "\|", 2
  if ($p.Count -eq 2) { [ordered]@{ name = $p[0]; date = $p[1] } }
}

# --- PRs (opcional) ---------------------------------------------------------
$prs = @()
if (Get-Command gh -ErrorAction SilentlyContinue) {
  try {
    $prs = gh pr list --state all --limit 50 --json number,title,state,mergedAt,createdAt,additions,deletions,headRefName,url | ConvertFrom-Json
  } catch {
    Write-Host "gh no disponible o sin sesión: se omiten los PRs."
  }
}

$json = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  repository  = "choruzo/CLI"
  branch      = (git branch --show-current)
  commits     = $commits
  tags        = @($tags)
  prs         = @($prs)
}

$body = $json | ConvertTo-Json -Depth 6
$utf8 = New-Object System.Text.UTF8Encoding($false)

$outputPath = Join-Path $PSScriptRoot "data/commits.json"
[System.IO.File]::WriteAllText($outputPath, $body, $utf8)

$jsOutputPath = Join-Path $PSScriptRoot "data/commits-data.js"
[System.IO.File]::WriteAllText($jsOutputPath, "window.__STRATUM_COMMITS__ = $body;`n", $utf8)

Write-Host "Updated data/commits.json and data/commits-data.js: $($commits.Count) commits, $(@($tags).Count) tags, $(@($prs).Count) PRs."

# --- Cache busting -----------------------------------------------------------
# Cloudflare sirve CSS/JS con Cache-Control max-age=14400: sin una versión en la URL,
# un visitante recurrente combina el index.html nuevo con el CSS/JS viejo de su caché.
# La versión es un hash del contenido, así que solo cambia cuando cambian los ficheros.
$assets = @("styles.css", "app.js", "data/commits-data.js") | ForEach-Object { Join-Path $PSScriptRoot $_ }
$sha = [System.Security.Cryptography.SHA1]::Create()
$bytes = [System.Collections.Generic.List[byte]]::new()
foreach ($a in $assets) { $bytes.AddRange([System.IO.File]::ReadAllBytes($a)) }
$version = ([System.BitConverter]::ToString($sha.ComputeHash($bytes.ToArray())) -replace "-", "").Substring(0, 10).ToLower()

$indexPath = Join-Path $PSScriptRoot "index.html"
$index = [System.IO.File]::ReadAllText($indexPath)
$index = [regex]::Replace($index, '((?:href|src)="\./(?:styles\.css|app\.js|data/commits-data\.js))(\?v=[^"]*)?"', "`$1?v=$version`"")
[System.IO.File]::WriteAllText($indexPath, $index, $utf8)

Write-Host "Assets versioned as ?v=$version in index.html."
