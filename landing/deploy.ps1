param(
  [switch]$Preview,
  [switch]$SkipRefresh,
  [string]$Project = "task-platform-landing"
)

# Publica la landing en Cloudflare Pages (proyecto de subida directa) con wrangler.
#
#   pwsh landing/deploy.ps1            # regenera el snapshot y publica en producción
#   pwsh landing/deploy.ps1 -Preview   # despliegue de prueba: URL propia, no toca taskplatform.pro
#
# Autenticación, una de las dos:
#   - `npx wrangler login` una vez (abre el navegador), o
#   - CLOUDFLARE_API_TOKEN (permiso Account · Cloudflare Pages · Edit) y CLOUDFLARE_ACCOUNT_ID.

$ErrorActionPreference = "Stop"

if (-not $SkipRefresh) {
  & (Join-Path $PSScriptRoot "refresh-commits.ps1")
}

# Se sube una copia sin los scripts de mantenimiento ni el zip: todo lo que hay en la carpeta publicada es público.
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "stratum-landing-$PID"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Copy-Item $PSScriptRoot $stage -Recurse -Exclude "*.ps1", "*.zip"

# Los instaladores viven en install/ (única copia) y se sirven desde la raíz:
# https://taskplatform.pro/install.sh y /install.ps1. Van después del filtro de
# arriba, que excluye los .ps1 de mantenimiento de esta carpeta.
$installDir = Join-Path $PSScriptRoot "..\install"
foreach ($name in "install.sh", "install.ps1") {
  $source = Join-Path $installDir $name
  if (-not (Test-Path $source)) { throw "Falta $source." }
  Copy-Item $source (Join-Path $stage $name)
}
# Con CRLF el script que baja curl no arranca (`/bin/sh^M`).
if ([System.IO.File]::ReadAllText((Join-Path $stage "install.sh")).Contains("`r")) {
  throw "install/install.sh tiene finales de línea CRLF; tiene que ir con LF."
}

# En Pages, la rama de producción es `main`; cualquier otra crea un despliegue de prueba.
$branch = if ($Preview) { "preview" } else { "main" }

try {
  npx --yes wrangler@latest pages deploy $stage --project-name $Project --branch $branch --commit-dirty=true
  if ($LASTEXITCODE -ne 0) { throw "wrangler terminó con código $LASTEXITCODE." }
} finally {
  Remove-Item $stage -Recurse -Force
}
