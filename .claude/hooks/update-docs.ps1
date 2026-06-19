# Hook Stop: actualiza CLI-DOC/ cuando la sesion incluyo implementacion real.
# Senhal: git detecta cambios en stratum-cli/src/**/*.ts(x) respecto a HEAD.
# Cubre codificacion directa y plan-and-execute (ambos dejan edits en el arbol de trabajo).

$lockFile = Join-Path $PSScriptRoot ".doc-update-running"
if (Test-Path $lockFile) { exit 0 }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\")).Path
$stratumSrc  = Join-Path $projectRoot "stratum-cli\src"

if (-not (Test-Path $stratumSrc)) { exit 0 }

# Archivos .ts/.tsx modificados o nuevos segun git
$gitDiffFiles = git -C $projectRoot diff --name-only HEAD 2>$null
$gitNewFiles  = git -C $projectRoot ls-files --others --exclude-standard -- "stratum-cli/src" 2>$null

$changedTs = @($gitDiffFiles) + @($gitNewFiles) |
    Where-Object { $_ -match "stratum-cli/src/.+\.(ts|tsx)$" }

if (-not $changedTs) { exit 0 }

# Rutas
$vaultPath = Join-Path $projectRoot "CLI-DOC"
$today     = Get-Date -Format "yyyy-MM-dd"

# Crear estructura del vault si no existe
foreach ($sub in @("Diario","Modulos")) {
    $dir = Join-Path $vaultPath $sub
    if (-not (Test-Path $dir)) { New-Item $dir -ItemType Directory -Force | Out-Null }
}

# Rutas absolutas para el prompt (git devuelve rutas relativas al repo)
$changedList = ($changedTs | ForEach-Object {
    "- " + (Join-Path $projectRoot ($_ -replace "/","\\"))
}) -join "`n"

# Prompt sin here-string para evitar problemas de encoding/terminador
$prompt = "Eres el documentalista del proyecto Stratum CLI. Actualiza la boveda Obsidian en '$vaultPath'.`n`n"
$prompt += "Archivos TypeScript con cambios reales en esta sesion (segun git diff HEAD):`n$changedList`n`n"
$prompt += "Directorio de trabajo del proyecto: $projectRoot`n`n"
$prompt += "Instrucciones:`n"
$prompt += "1. Lee cada archivo listado para entender que se implemento o modifico.`n"
$prompt += "2. Actualiza o crea '$vaultPath\Diario\$today.md':`n"
$prompt += "   - Si existe: anhade una seccion ## HH:MM con los cambios de esta sesion.`n"
$prompt += "   - Si no existe: crea el archivo con frontmatter YAML y la entrada completa.`n"
$prompt += "3. Para cada modulo core tocado (agent/, providers/, tools/, memory/, cli/, config/),`n"
$prompt += "   actualiza o crea '$vaultPath\Modulos\<nombre-modulo>.md' con descripcion tecnica.`n"
$prompt += "4. Si algun hito avanzo o completo, actualiza '$vaultPath\Roadmap.md'.`n`n"
$prompt += "Formato Obsidian obligatorio:`n"
$prompt += "- Frontmatter YAML: date, tags (array), status`n"
$prompt += "- Wikilinks: [[Roadmap]], [[Arquitectura]], [[Modulos/agent]]`n"
$prompt += "- Headings ## y ### (nunca #)`n"
$prompt += "- Solo documenta lo que realmente esta en el codigo."

New-Item $lockFile -ItemType File -Force | Out-Null

try {
    Set-Location $projectRoot
    Write-Host "Actualizando CLI-DOC/ ($($changedTs.Count) archivo(s) modificados)..."
    claude -p $prompt --allowedTools "Read,Write,Edit" --bare --dangerously-skip-permissions
} finally {
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}
