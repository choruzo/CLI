# Hook Stop: actualiza la bóveda Obsidian CLI-DOC/ cuando la sesión incluyó implementación real.
# "Implementación real" = git detecta cambios en stratum-cli/src/**/*.ts(x) respecto a HEAD.
# Esto cubre tanto sesiones de codificación directa como plan-and-execute: en ambos casos
# los edits reales quedan reflejados en git diff antes de que el hook se dispare.

$lockFile = Join-Path $PSScriptRoot ".doc-update-running"
if (Test-Path $lockFile) { exit 0 }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\")).Path
$stratumSrc  = Join-Path $projectRoot "stratum-cli\src"

if (-not (Test-Path $stratumSrc)) { exit 0 }

# ── Señal de implementación: git diff (staged + unstaged vs HEAD) ──────────────
# También incluye archivos nuevos no rastreados dentro de src/ (recién creados en este hito).
$gitDiffFiles = git -C $projectRoot diff --name-only HEAD 2>$null
$gitNewFiles  = git -C $projectRoot ls-files --others --exclude-standard -- "stratum-cli/src" 2>$null

$changedTs = @($gitDiffFiles) + @($gitNewFiles) |
    Where-Object { $_ -match "stratum-cli/src/.+\.(ts|tsx)$" }

if (-not $changedTs) { exit 0 }   # Solo conversación o planificación sin edits → silencio.

# ── Rutas ──────────────────────────────────────────────────────────────────────
$vaultPath = Join-Path $projectRoot "CLI-DOC"
$today     = Get-Date -Format "yyyy-MM-dd"

# Garantiza que el vault existe antes de que el agente headless intente escribir en él.
@("Diario","Módulos") | ForEach-Object {
    $dir = Join-Path $vaultPath $_
    if (-not (Test-Path $dir)) { New-Item $dir -ItemType Directory -Force | Out-Null }
}

# Lista con rutas absolutas para el prompt (git devuelve rutas relativas al repo).
$changedList = ($changedTs | ForEach-Object {
    "- " + (Join-Path $projectRoot ($_ -replace "/","\\"))
}) -join "`n"

# ── Prompt para el agente documentalista ──────────────────────────────────────
$prompt = @"
Eres el documentalista del proyecto Stratum CLI. Actualiza la bóveda Obsidian en '$vaultPath'.

Archivos TypeScript con cambios reales en esta sesión (según git diff HEAD):
$changedList

Directorio de trabajo del proyecto: $projectRoot

Instrucciones:
1. Lee cada archivo listado para entender qué se implementó o modificó.
2. Actualiza o crea '$vaultPath\Diario\$today.md':
   - Si existe: añade una nueva sección ##