# Instalador de Stratum (CLI y, opcionalmente, Stratum Desktop) para Windows.
#
#   irm https://taskplatform.pro/install.ps1 | iex
#
# Con opciones (irm | iex no admite argumentos):
#
#   & ([scriptblock]::Create((irm https://taskplatform.pro/install.ps1))) -Desktop -BaseUrl http://localhost:11434/v1
#
# o con variables STRATUM_INSTALL_* antes del irm | iex. En Linux y macOS se usa install.sh.
#
# Funciona en Windows PowerShell 5.1 y en PowerShell 7. El fichero es ASCII
# puro (sin tildes) a proposito: PowerShell 5.1 lee como ANSI un .ps1 sin BOM,
# y un BOM no sobrevive de forma fiable a irm | iex.

[CmdletBinding()]
param(
  # Instala tambien Stratum Desktop (Windows x64)
  [switch]$Desktop,
  # No instala la CLI (solo Desktop y/o configuracion)
  [switch]$NoCli,
  # Canal de publicacion: stable o beta
  [string]$Channel,
  # Version concreta de la CLI
  [string]$Version,
  # Version concreta de Desktop
  [string]$DesktopVersion,
  # URL base de la API OpenAI-compatible (con /v1)
  [string]$BaseUrl,
  # Alias del provider (por defecto: default)
  [string]$Provider,
  # API key literal (queda en claro en el fichero)
  [string]$ApiKey,
  # Variable de entorno con la API key (se guarda ${VAR})
  [string]$ApiKeyEnv,
  # Modelo por defecto; sin el se elige al arrancar
  [string]$Model,
  # Ruta o URL de un .stratumrc.json ya preparado
  [string]$Config,
  # No pregunta ni toca la configuracion
  [switch]$NoConfig,
  # No pregunta nada: acepta instalar Node.js y PowerShell 7 si faltan
  [switch]$Yes,
  # Muestra lo que haria sin hacerlo
  [switch]$DryRun
)

# Todo va dentro de una funcion: con irm | iex el script corre en la sesion del
# usuario, y ni las preferencias ni un `exit` deben escaparse a ella.
function Install-Stratum {
  param($Opt)

  if (-not $Opt) { $Opt = @{} }
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # la barra de progreso de 5.1 multiplica el tiempo de descarga
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo = 'choruzo/CLI'
  $Package = 'stratum-cli'
  $MinNode = 22
  $StratumHome = Join-Path $env:USERPROFILE '.stratum'
  $GlobalConfig = Join-Path $StratumHome '.stratumrc.json'
  # Lo que las funciones anidadas modifican va en una tabla: asignar una
  # variable suelta desde ellas crearia una local.
  $state = @{ CliEntry = $null; TmpDir = $null }

  function Step($m) { Write-Host '==> ' -ForegroundColor Green -NoNewline; Write-Host $m }
  function Info($m) { Write-Host "    $m" }
  function Warn($m) { Write-Host 'aviso: ' -ForegroundColor Yellow -NoNewline; Write-Host $m }
  function Trace($m) { Write-Host "    + $m" -ForegroundColor DarkGray }
  function Has($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

  # Cada opcion tiene su variable STRATUM_INSTALL_*; el parametro gana.
  function Pick($value, $envName) {
    if ($value) { return [string]$value }
    return [string][Environment]::GetEnvironmentVariable("STRATUM_INSTALL_$envName")
  }
  function Flag($value, $envName) {
    return [bool]$value -or ([Environment]::GetEnvironmentVariable("STRATUM_INSTALL_$envName") -eq '1')
  }

  $desktop = Flag $Opt['Desktop'] 'DESKTOP'
  $noCli = Flag $Opt['NoCli'] 'NO_CLI'
  $noConfig = Flag $Opt['NoConfig'] 'NO_CONFIG'
  $yes = Flag $Opt['Yes'] 'YES'
  $dryRun = [bool]$Opt['DryRun']
  $channel = Pick $Opt['Channel'] 'CHANNEL'
  if (-not $channel) { $channel = 'stable' }
  if (@('stable', 'beta') -notcontains $channel) { throw '-Channel admite stable o beta.' }
  $cliVersion = (Pick $Opt['Version'] 'VERSION') -replace '^v', ''
  $desktopVersion = (Pick $Opt['DesktopVersion'] 'DESKTOP_VERSION') -replace '^v', ''
  $configSource = Pick $Opt['Config'] 'CONFIG'
  $providerOpts = @{
    Provider  = Pick $Opt['Provider'] 'PROVIDER'
    BaseUrl   = Pick $Opt['BaseUrl'] 'BASE_URL'
    ApiKey    = Pick $Opt['ApiKey'] 'API_KEY'
    ApiKeyEnv = Pick $Opt['ApiKeyEnv'] 'API_KEY_ENV'
    Model     = Pick $Opt['Model'] 'MODEL'
  }

  $interactive = (-not $yes) -and [Environment]::UserInteractive -and (-not [Console]::IsInputRedirected)

  function Confirm-Step($question, $defaultYes) {
    if (-not $interactive) { return $yes }
    $suffix = if ($defaultYes) { '[S/n]' } else { '[s/N]' }
    $answer = (Read-Host "$question $suffix").Trim()
    if (-not $answer) { return $defaultYes }
    return $answer -match '^(s|si|y|yes)$'
  }

  # Ejecuta un comando nativo y falla si no sale con 0. Sin redirigir stderr:
  # en 5.1 cualquier linea que un nativo escribe ahi se vuelve un error.
  function Invoke-Native($exe, [string[]]$arguments) {
    if ($dryRun) { Trace "$exe $($arguments -join ' ')"; return }
    & $exe @arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$exe termino con codigo $LASTEXITCODE." }
  }

  # winget y los instaladores cambian el PATH del registro, no el de esta sesion.
  function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $known = $env:Path -split ';'
    $added = @($machine, $user) -split ';' | Where-Object { $_ -and ($known -notcontains $_) }
    if ($added) { $env:Path = (@($env:Path) + $added) -join ';' }
  }

  function Install-WithWinget($id, $label) {
    if (-not (Has 'winget')) { return $false }
    Step "Instalando $label con winget"
    Invoke-Native 'winget' @('install', '--id', $id, '-e', '--accept-source-agreements', '--accept-package-agreements')
    Update-SessionPath
    return $true
  }

  function Get-TempDir {
    if (-not $state.TmpDir) {
      $state.TmpDir = Join-Path ([IO.Path]::GetTempPath()) ('stratum-install-' + [Guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $state.TmpDir | Out-Null
    }
    return $state.TmpDir
  }

  function Save-Url($url, $path) {
    try { Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing }
    catch { throw "no se pudo descargar $url ($($_.Exception.Message))" }
  }

  # Siempre npm.cmd: `npm` a secas resuelve a npm.ps1, que la politica de
  # ejecucion por defecto de Windows no deja correr.
  function Get-NpmRoot {
    $root = [string](& npm.cmd root -g | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or -not $root.Trim()) { throw 'npm no devolvio su carpeta global (npm root -g).' }
    return $root.Trim()
  }

  function Get-NodeMajor {
    if (-not (Has 'node')) { return 0 }
    return [int](& node -p 'process.versions.node.split(/[.]/)[0]')
  }

  function Assert-Node {
    Step 'Comprobando Node.js'
    $major = Get-NodeMajor
    if ($major -ge $MinNode -and (Has 'npm.cmd')) {
      Info "Node.js $(& node -v) / npm $(& npm.cmd -v)"
      return
    }
    if ($major -gt 0) { Warn "Node.js $(& node -v) es anterior a la $MinNode que necesita Stratum." }
    else { Warn 'no se encontro Node.js.' }
    $manual = "Stratum necesita Node.js $MinNode o superior: instalalo desde https://nodejs.org y vuelve a lanzar el instalador."
    if (-not (Confirm-Step 'Instalar Node.js LTS con winget?' $true)) { throw $manual }
    if (-not (Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS')) { throw "winget no esta disponible. $manual" }
    if ($dryRun) { return }
    if ((Get-NodeMajor) -lt $MinNode) { throw 'Node.js se instalo pero esta sesion no lo ve: abre un terminal nuevo y relanza el instalador.' }
  }

  # El shell local de Stratum en Windows es pwsh.exe (PowerShell 7); con solo
  # Windows PowerShell 5.1 la tool `exec` no arranca.
  function Assert-Pwsh {
    if (Has 'pwsh') { return }
    Warn 'Stratum ejecuta los comandos con PowerShell 7 (pwsh.exe) y no esta instalado.'
    if (Confirm-Step 'Instalar PowerShell 7 con winget?' $true) {
      if (Install-WithWinget 'Microsoft.PowerShell' 'PowerShell 7') { return }
    }
    Warn 'sin PowerShell 7 el agente no podra ejecutar comandos: winget install Microsoft.PowerShell'
  }

  function Install-Cli {
    $spec = if ($cliVersion) { "$Package@$cliVersion" } elseif ($channel -eq 'beta') { "$Package@beta" } else { "$Package@latest" }
    Step "Instalando la CLI ($spec)"
    Invoke-Native 'npm.cmd' @('install', '-g', $spec)
    if ($dryRun) { return }
    Update-SessionPath
    $root = (Get-NpmRoot)
    $entry = Join-Path $root "$Package\dist\index.js"
    if (-not (Test-Path $entry)) { throw "npm termino pero no dejo $entry." }
    $state.CliEntry = $entry
    Info "stratum $(& node $entry --version)"
    if (-not (Has 'stratum')) {
      Warn "la carpeta global de npm ($(Split-Path $root)) no esta en el PATH: abre un terminal nuevo o anadela."
    }
  }

  # Ultima release `desktop-v*` publicada. La "latest" de GitHub es la de la
  # CLI, asi que se recorre la lista (de mas nueva a mas antigua). En el canal
  # estable se saltan las versiones con sufijo (-beta.N).
  function Get-LatestDesktopVersion {
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=100" -Headers @{ 'User-Agent' = 'stratum-installer' }
    foreach ($r in $releases) {
      if ($r.draft -or $r.tag_name -notlike 'desktop-v*') { continue }
      $v = $r.tag_name.Substring('desktop-v'.Length)
      if ($channel -ne 'beta' -and $v -match '-') { continue }
      if (-not ($r.assets | Where-Object { $_.name -like '*_x64-setup.exe' })) { continue }
      return $v
    }
    return $null
  }

  function Install-Desktop {
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
      Warn 'Stratum Desktop solo se publica para Windows x64 y Linux x64; se omite.'
      return
    }
    $v = $desktopVersion
    if (-not $v) { $v = Get-LatestDesktopVersion }
    if (-not $v) { throw "no se encontro ninguna release de Stratum Desktop en el canal $channel (prueba -Channel beta)." }

    Step "Instalando Stratum Desktop $v"
    $asset = "Stratum_${v}_x64-setup.exe"
    $base = "https://github.com/$Repo/releases/download/desktop-v$v"
    if ($dryRun) { Trace "descargar $base/$asset, verificar su SHA-256 y ejecutarlo con /S"; return }

    $dir = Get-TempDir
    $exe = Join-Path $dir $asset
    $sumsFile = Join-Path $dir 'SHA256SUMS.txt'
    Save-Url "$base/$asset" $exe
    Save-Url "$base/SHA256SUMS.txt" $sumsFile
    $expected = $null
    foreach ($line in (Get-Content $sumsFile)) {
      $parts = $line.Trim() -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0]; break }
    }
    if (-not $expected) { throw "no hay suma SHA-256 publicada para $asset." }
    $actual = (Get-FileHash -Path $exe -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw "la suma SHA-256 de $asset no coincide (esperada $expected, obtenida $actual)." }
    Info 'SHA-256 verificado'

    # Instalador NSIS por usuario: /S lo hace en silencio y sin elevar.
    $p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "el instalador de Desktop termino con codigo $($p.ExitCode)." }
    Info 'instalado: busca "Stratum" en el menu Inicio (se actualiza solo desde la app)'
  }

  function Find-Cli {
    if ($state.CliEntry) { return $true }
    if (-not ((Has 'npm.cmd') -and (Has 'node'))) { return $false }
    $entry = Join-Path (Get-NpmRoot) "$Package\dist\index.js"
    if (Test-Path $entry) { $state.CliEntry = $entry; return $true }
    return $false
  }

  # El alta la hace la propia CLI (valida, consulta /models y escribe de forma
  # atomica). Se lanza desde ~/.stratum para que escriba la config global y no
  # la de un proyecto del directorio actual, y con node directamente: el shim
  # stratum.cmd pasa por cmd.exe, que estropea una key con & o %.
  function Invoke-StratumGlobal([string[]]$arguments, [switch]$Quiet) {
    Push-Location $StratumHome
    try {
      if ($Quiet) { & node $state.CliEntry @arguments | Out-Null }
      else { & node $state.CliEntry @arguments | Out-Host }
      return $LASTEXITCODE -eq 0
    } finally { Pop-Location }
  }

  function Install-ConfigFile {
    Step "Instalando la configuracion global desde $configSource"
    if ($dryRun) { Trace "copiar a $GlobalConfig (con copia de la anterior)"; return }
    $staged = Join-Path (Get-TempDir) 'stratumrc.json'
    if ($configSource -match '^https?://') {
      Save-Url $configSource $staged
    } else {
      if (-not (Test-Path $configSource -PathType Leaf)) { throw "no existe $configSource" }
      Copy-Item $configSource $staged
    }
    $backup = $null
    if (Test-Path $GlobalConfig) {
      $backup = "$GlobalConfig.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
      Copy-Item $GlobalConfig $backup
      Info "copia de la anterior: $backup"
    }
    Copy-Item $staged $GlobalConfig -Force
    # La CLI es quien sabe si el fichero vale: si lo rechaza, se deshace.
    if (Find-Cli) {
      if (-not (Invoke-StratumGlobal @('config', 'get', 'memory.globalFile') -Quiet)) {
        if ($backup) { Copy-Item $backup $GlobalConfig -Force } else { Remove-Item $GlobalConfig -Force }
        throw 'la configuracion no es valida; se ha dejado todo como estaba.'
      }
    }
    Info "escrita en $GlobalConfig"
  }

  function Read-Provider {
    Write-Host ''
    Write-Host 'Provider del modelo (cualquier API OpenAI-compatible)'
    Write-Host '  1) Ollama       http://localhost:11434/v1'
    Write-Host '  2) llama.cpp    http://localhost:8080/v1'
    Write-Host '  3) LM Studio    http://localhost:1234/v1'
    Write-Host '  4) OpenAI       https://api.openai.com/v1'
    Write-Host '  5) Otra URL'
    $choice = (Read-Host 'Elige [1]').Trim()
    $p = @{ Provider = 'default'; BaseUrl = ''; ApiKey = ''; ApiKeyEnv = ''; Model = '' }
    switch ($choice) {
      '' { $p.BaseUrl = 'http://localhost:11434/v1'; $p.Provider = 'ollama' }
      '1' { $p.BaseUrl = 'http://localhost:11434/v1'; $p.Provider = 'ollama' }
      '2' { $p.BaseUrl = 'http://localhost:8080/v1'; $p.Provider = 'llamacpp' }
      '3' { $p.BaseUrl = 'http://localhost:1234/v1'; $p.Provider = 'lmstudio' }
      '4' { $p.BaseUrl = 'https://api.openai.com/v1'; $p.Provider = 'openai' }
      default { $p.BaseUrl = (Read-Host 'URL base de la API (con /v1)').Trim() }
    }
    if (-not $p.BaseUrl) { return $null }
    $alias = (Read-Host "Alias del provider [$($p.Provider)]").Trim()
    if ($alias) { $p.Provider = $alias }
    $secure = Read-Host "API key (vacio si no hace falta; se guarda en claro en $GlobalConfig)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $p.ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $p.Model = (Read-Host 'Modelo por defecto (vacio: se elige al arrancar)').Trim()
    return $p
  }

  function Set-Provider($p) {
    if (-not $p.Provider) { $p.Provider = 'default' }
    if ($p.ApiKey -and $p.ApiKeyEnv) { throw 'usa -ApiKey o -ApiKeyEnv, no los dos.' }
    Step "Configurando el provider '$($p.Provider)' ($($p.BaseUrl))"
    if ($dryRun) {
      # La key no se muestra ni en el simulacro.
      Trace "stratum provider add $($p.Provider) --base-url $($p.BaseUrl) --default ..."
      return
    }
    $arguments = @('provider', 'add', $p.Provider, '--base-url', $p.BaseUrl, '--default')
    if ($p.ApiKeyEnv) { $arguments += @('--api-key-env', $p.ApiKeyEnv) }
    if ($p.ApiKey) { $arguments += @('--api-key', $p.ApiKey) }
    if ($p.Model) { $arguments += @('--model', $p.Model) }
    if (-not (Invoke-StratumGlobal $arguments)) {
      Warn 'no se pudo configurar el provider; hazlo despues con: stratum provider add'
    } elseif ($p.ApiKeyEnv) {
      Info "recuerda definir $($p.ApiKeyEnv) como variable de entorno de usuario (setx $($p.ApiKeyEnv) ...)"
    }
  }

  function Set-GlobalConfig {
    if ($noConfig) { return }
    if (-not $dryRun) { New-Item -ItemType Directory -Force -Path $StratumHome | Out-Null }
    if ($configSource) { Install-ConfigFile; return }
    $p = $providerOpts
    if (-not $p.BaseUrl) {
      # Sin opciones solo se pregunta en una instalacion nueva: una config que
      # ya existe no se toca.
      if (Test-Path $GlobalConfig) { Info "ya hay configuracion global en $GlobalConfig; no se modifica"; return }
      if (-not $interactive) { return }
      if (-not $dryRun) { if (-not (Find-Cli)) { return } }
      if (-not (Confirm-Step 'Configurar ahora el provider del modelo?' $true)) { return }
      $p = Read-Provider
      if (-not $p) { return }
    }
    if (-not $dryRun) {
      if (-not (Find-Cli)) {
        Warn 'la configuracion la escribe la CLI y no esta instalada; Stratum Desktop te guiara en su primer arranque.'
        return
      }
    }
    Set-Provider $p
  }

  try {
    Write-Host 'Stratum - instalador (windows)'
    if ($dryRun) { Info 'simulacro: no se cambia nada' }
    if (-not $noCli) {
      Assert-Node
      Assert-Pwsh
      Install-Cli
    }
    if ($desktop) { Install-Desktop }
    Set-GlobalConfig

    Write-Host ''
    Write-Host 'Listo.' -ForegroundColor Green
    if (-not $noCli) {
      Info 'Empieza con:  stratum chat'
      if (-not (Test-Path $GlobalConfig)) { Info 'Sin provider configurado todavia:  stratum provider add' }
    }
  } finally {
    if ($state.TmpDir) { Remove-Item $state.TmpDir -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

try {
  Install-Stratum -Opt $PSBoundParameters
} catch {
  # Sin `exit`: con irm | iex cerraria el terminal del usuario.
  Write-Host 'error: ' -ForegroundColor Red -NoNewline
  Write-Host $_.Exception.Message
}
