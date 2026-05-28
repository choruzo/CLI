# Hook PostToolUse: auto-format y lint tras editar TypeScript en stratum-cli/src
$json = [Console]::In.ReadToEnd() | ConvertFrom-Json
$path = if ($json.tool_input.file_path) { $json.tool_input.file_path } else { "" }

if ($path -match "stratum-cli.+\.(ts|tsx)$") {
    Push-Location (Join-Path $PSScriptRoot "..\..\stratum-cli")
    npm run format 2>&1 | Write-Host
    npm run lint 2>&1 | Write-Host
    Pop-Location
}

# Siempre exit 0: lint es informativo, no bloqueante.
# Sin esto, un exit code != 0 de ESLint se propaga como fallo del hook.
exit 0
