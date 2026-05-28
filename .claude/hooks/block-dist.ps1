# Hook PreToolUse: bloquear ediciones directas a dist/ (salida compilada de tsup)
$json = [Console]::In.ReadToEnd() | ConvertFrom-Json
$path = if ($json.tool_input.file_path) { $json.tool_input.file_path } else { "" }

if ($path -match "[/\\]dist[/\\]") {
    Write-Host "Bloqueado: no editar dist/ directamente — ejecuta 'npm run build' en stratum-cli."
    exit 2
}
