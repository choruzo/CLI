# Hook Stop: actualiza la bóveda Obsidian CLI-DOC/ cuando hay cambios en src/
# Llama a claude -p en modo headless para generar documentación técnica

$lockFile = Join-Path $PSScriptRoot ".doc-update-running"
if (Test-Path $lockFile) { exit 0 }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\")).Path
$srcPath = Join-Path $projectRoot "stratum-cli\src"

if (-not (Test-Path $srcPath)) { exit 0 }

# Solo actuar si hay archivos .ts/.tsx modificados en los últimos 15 minutos
$cutoff = (Get-Date).AddMinutes(-15)
$recentFiles = Get-ChildItem $srcPath -Recurse -Include "*.ts","*.tsx" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $cutoff }

if (-not $recentFiles) { exit 0 }

$vaultPath = Join-Path $projectRoot "CLI-DOC"
$today = Get-Date -Format "yyyy-MM-dd"
$changedList = ($recentFiles | ForEach-Object { "- " + $_.FullName }) -join "`n"

$prompt = @"
Eres el documentalista del proyecto Stratum CLI. Actualiza la bóveda Obsidian en '$vaultPath'.

Archivos TypeScript modificados en los últimos 15 minutos:
$changedList

Directorio de trabajo del proyecto: $projectRoot

Instrucciones:
1. Lee cada archivo modificado para entender qué se implementó
2. Actualiza o crea '$vaultPath\Diario\$today.md':
   - Si existe: añade una nueva sección ## HH:MM con los cambios de esta sesión
   - Si no existe: crea el archivo con frontmatter y la entrada completa del día
3. Para cada módulo core modificado (agent/, providers/, tools/, memory/, cli/, config/),
   actualiza o crea '$vaultPath\Módulos\<nombre-módulo>.md' con descripción técnica actualizada
4. Si el Hito 0 está completo o avanzó algún hito, actualiza '$vaultPath\Roadmap.md'

Formato Obsidian obligatorio:
- Frontmatter YAML: date, tags (array), status
- Wikilinks para referencias cruzadas: [[Roadmap]], [[Arquitectura]], [[Módulos/agent]]
- Headings ## y ### (nunca #)
- Sé técnico y conciso — solo documenta lo que realmente está en el código
"@

New-Item $lockFile -ItemType File -Force | Out-Null

try {
    Set-Location $projectRoot
    Write-Host "Actualizando documentacion en CLI-DOC/..."
    claude -p $prompt --allowedTools "Read,Write,Edit"
} finally {
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}
