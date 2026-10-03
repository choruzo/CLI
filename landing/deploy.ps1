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

# Se sube una copia sin los scripts ni el zip: todo lo que hay en la carpeta publicada es público.
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "stratum-landing-$PID"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Copy-Item $PSScriptRoot $stage -Recurse -Exclude "*.ps1", "*.zip"

# En Pages, la rama de producción es `main`; cualquier otra crea un despliegue de prueba.
$branch = if ($Preview) { "preview" } else { "main" }

try {
  npx --yes wrangler@latest pages deploy $stage --project-name $Project --branch $branch --commit-dirty=true
  if ($LASTEXITCODE -ne 0) { throw "wrangler terminó con código $LASTEXITCODE." }
} finally {
  Remove-Item $stage -Recurse -Force
}
