#!/bin/sh
# Instalador de Stratum (CLI y, opcionalmente, Stratum Desktop) para Linux y macOS.
#
#   curl -fsSL https://taskplatform.pro/install.sh | sh
#   curl -fsSL https://taskplatform.pro/install.sh | sh -s -- --desktop
#
# En Windows se usa install.ps1. Opciones: `sh install.sh --help`.
#
# Todo el script vive dentro de funciones y `main` se llama en la última línea:
# una descarga cortada a medias no llega a ejecutar nada.

set -eu

REPO="choruzo/CLI"
PACKAGE="stratum-cli"
MIN_NODE=22
NODE_LINE="latest-v22.x"

STRATUM_HOME="$HOME/.stratum"
GLOBAL_CONFIG="$STRATUM_HOME/.stratumrc.json"
USER_BIN="$HOME/.local/bin"

# Cada opción tiene su variable STRATUM_INSTALL_*; el flag gana.
INSTALL_CLI=1
[ "${STRATUM_INSTALL_NO_CLI:-}" = "1" ] && INSTALL_CLI=0
INSTALL_DESKTOP=0
[ "${STRATUM_INSTALL_DESKTOP:-}" = "1" ] && INSTALL_DESKTOP=1
CHANNEL="${STRATUM_INSTALL_CHANNEL:-stable}"
CLI_VERSION="${STRATUM_INSTALL_VERSION:-}"
DESKTOP_VERSION="${STRATUM_INSTALL_DESKTOP_VERSION:-}"
DESKTOP_FORMAT="${STRATUM_INSTALL_DESKTOP_FORMAT:-auto}"
PROVIDER="${STRATUM_INSTALL_PROVIDER:-}"
BASE_URL="${STRATUM_INSTALL_BASE_URL:-}"
API_KEY="${STRATUM_INSTALL_API_KEY:-}"
API_KEY_ENV="${STRATUM_INSTALL_API_KEY_ENV:-}"
MODEL="${STRATUM_INSTALL_MODEL:-}"
CONFIG_SOURCE="${STRATUM_INSTALL_CONFIG:-}"
ASSUME_YES=0
[ "${STRATUM_INSTALL_YES:-}" = "1" ] && ASSUME_YES=1
SKIP_CONFIG=0
[ "${STRATUM_INSTALL_NO_CONFIG:-}" = "1" ] && SKIP_CONFIG=1
DRY_RUN=0

# El PATH con el que llegó el usuario: el script lo amplía para sí mismo, pero
# lo que cuenta es si un terminal nuevo encontrará los ejecutables.
USER_PATH="$PATH"
TMP_DIR=""
PATH_HINT=0
STRATUM_BIN=""

usage() {
  cat <<'EOF'
Instalador de Stratum

Uso:
  curl -fsSL https://taskplatform.pro/install.sh | sh -s -- [opciones]

Qué instalar:
  --desktop                 Instala también Stratum Desktop (Linux x64)
  --no-cli                  No instala la CLI (solo Desktop y/o configuración)
  --channel stable|beta     Canal de publicación (por defecto: stable)
  --version <x.y.z>         Versión concreta de la CLI
  --desktop-version <x.y.z> Versión concreta de Desktop
  --desktop-format auto|deb|appimage
                            Paquete de Desktop (auto: .deb si hay apt y sudo; si no, AppImage)

Configuración global (~/.stratum/.stratumrc.json, la comparten CLI y Desktop):
  --base-url <url>          URL base de la API OpenAI-compatible (con /v1)
  --provider <alias>        Alias del provider (por defecto: default)
  --api-key-env <VAR>       Variable de entorno con la API key (se guarda ${VAR})
  --api-key <key>           API key literal (queda en claro en el fichero)
  --model <id>              Modelo por defecto; sin él se elige al arrancar
  --config <ruta|url>       Instala un .stratumrc.json ya preparado como config global
  --no-config               No pregunta ni toca la configuración

Otros:
  -y, --yes                 No pregunta nada: acepta instalar Node.js si falta
  --dry-run                 Muestra lo que haría sin hacerlo
  -h, --help                Esta ayuda

Cada opción tiene su variable de entorno STRATUM_INSTALL_* (DESKTOP=1,
CHANNEL, VERSION, BASE_URL, PROVIDER, API_KEY, API_KEY_ENV, MODEL, CONFIG, YES=1…).
EOF
}

# -----------------------------------------------------------------------------
# Salida
# -----------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$(printf '\033[1m'); C_DIM=$(printf '\033[2m'); C_RED=$(printf '\033[31m')
  C_GREEN=$(printf '\033[32m'); C_YELLOW=$(printf '\033[33m'); C_RESET=$(printf '\033[0m')
else
  C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_RESET=""
fi

step() { printf '%s==>%s %s%s%s\n' "$C_GREEN" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%saviso:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

cleanup() { [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"; return 0; }
trap cleanup EXIT

has() { command -v "$1" >/dev/null 2>&1; }

# Ejecuta el comando, o solo lo enseña con --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '    %s+ %s%s\n' "$C_DIM" "$*" "$C_RESET"
  else
    "$@"
  fi
}

# -----------------------------------------------------------------------------
# Preguntas: con `curl | sh` stdin es la tubería, así que se lee del terminal.
# -----------------------------------------------------------------------------

interactive() {
  [ "$ASSUME_YES" = 0 ] && (: </dev/tty) 2>/dev/null
}

# ask <pregunta> [valor por defecto] -> respuesta en $REPLY
ask() {
  if [ -n "${2:-}" ]; then
    printf '%s [%s]: ' "$1" "$2" >/dev/tty
  else
    printf '%s: ' "$1" >/dev/tty
  fi
  IFS= read -r REPLY </dev/tty || REPLY=""
  [ -z "$REPLY" ] && REPLY="${2:-}"
  return 0
}

ask_secret() {
  printf '%s: ' "$1" >/dev/tty
  stty -echo </dev/tty 2>/dev/null || true
  IFS= read -r REPLY </dev/tty || REPLY=""
  stty echo </dev/tty 2>/dev/null || true
  printf '\n' >/dev/tty
}

# confirm <pregunta> <s|n por defecto>; sin terminal vale --yes.
confirm() {
  if ! interactive; then
    [ "$ASSUME_YES" = 1 ]
    return
  fi
  if [ "$2" = s ]; then ask "$1 [S/n]" ""; else ask "$1 [s/N]" ""; fi
  case "${REPLY:-$2}" in
    s | S | si | sí | y | Y | yes) return 0 ;;
    *) return 1 ;;
  esac
}

# -----------------------------------------------------------------------------
# Descargas
# -----------------------------------------------------------------------------

# fetch <url> -> stdout
fetch() {
  if has curl; then
    curl -fsSL "$1"
  elif has wget; then
    wget -qO- "$1"
  else
    die "hace falta curl o wget."
  fi
}

# download <url> <destino>
download() {
  if has curl; then
    if [ -t 2 ]; then curl -fL --progress-bar -o "$2" "$1"; else curl -fsSL -o "$2" "$1"; fi
  else
    wget -q --show-progress -O "$2" "$1"
  fi
}

sha256_of() {
  if has sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif has shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "hace falta sha256sum o shasum para verificar la descarga."
  fi
}

# verify_sha256 <fichero> <fichero de sumas> <nombre dentro de las sumas>
verify_sha256() {
  expected=$(awk -v n="$3" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print $1; exit } }' "$2")
  [ -n "$expected" ] || die "no hay suma SHA-256 publicada para $3."
  actual=$(sha256_of "$1")
  [ "$expected" = "$actual" ] || die "la suma SHA-256 de $3 no coincide (esperada $expected, obtenida $actual)."
  info "SHA-256 verificado"
}

make_tmp() {
  [ -n "$TMP_DIR" ] || TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/stratum-install.XXXXXX")
}

# -----------------------------------------------------------------------------
# Plataforma
# -----------------------------------------------------------------------------

detect_platform() {
  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    MINGW* | MSYS* | CYGWIN*)
      die "en Windows se usa el instalador de PowerShell:  irm https://taskplatform.pro/install.ps1 | iex"
      ;;
    *) die "sistema no soportado: $(uname -s)." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "arquitectura no soportada: $(uname -m)." ;;
  esac
}

in_path() {
  case ":$USER_PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Enlaza un ejecutable en ~/.local/bin (sin sudo) y recuerda avisar del PATH.
link_user_bin() {
  run mkdir -p "$USER_BIN"
  run ln -sf "$1" "$USER_BIN/$2"
  in_path "$USER_BIN" || PATH_HINT=1
}

# -----------------------------------------------------------------------------
# Node.js
# -----------------------------------------------------------------------------

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# Node portátil en ~/.stratum/node: no toca el sistema ni pide sudo.
install_node() {
  if [ "$OS" = linux ] && { [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); }; then
    die "nodejs.org no publica binarios para musl. Instala Node.js $MIN_NODE+ con el gestor de paquetes (apk add nodejs npm) y vuelve a lanzar el instalador."
  fi
  make_tmp
  base="https://nodejs.org/dist/$NODE_LINE"
  fetch "$base/SHASUMS256.txt" >"$TMP_DIR/node-sums.txt" || die "no se pudo consultar nodejs.org."
  tarball=$(awk -v s="-$OS-$ARCH.tar.gz" 'index($2, s) && $2 ~ /^node-v/ { print $2; exit }' "$TMP_DIR/node-sums.txt")
  [ -n "$tarball" ] || die "nodejs.org no publica Node $NODE_LINE para $OS-$ARCH."

  step "Instalando Node.js (${tarball%.tar.gz}) en $STRATUM_HOME/node"
  if [ "$DRY_RUN" = 1 ]; then
    run download "$base/$tarball" "$TMP_DIR/$tarball"
  else
    download "$base/$tarball" "$TMP_DIR/$tarball"
    verify_sha256 "$TMP_DIR/$tarball" "$TMP_DIR/node-sums.txt" "$tarball"
    rm -rf "$STRATUM_HOME/node"
    mkdir -p "$STRATUM_HOME/node"
    tar -xzf "$TMP_DIR/$tarball" -C "$STRATUM_HOME/node" --strip-components=1
  fi
  for bin in node npm npx; do
    link_user_bin "$STRATUM_HOME/node/bin/$bin" "$bin"
  done
  PATH="$STRATUM_HOME/node/bin:$PATH"
  export PATH
}

# Un Node portátil de una ejecución anterior también cuenta, aunque el
# terminal desde el que se relanza no lo tenga en el PATH.
adopt_portable_node() {
  if [ -x "$STRATUM_HOME/node/bin/node" ]; then
    if ! has node || [ "$(node_major)" -lt "$MIN_NODE" ]; then
      PATH="$STRATUM_HOME/node/bin:$PATH"
      export PATH
    fi
  fi
}

ensure_node() {
  if has node && has npm && [ "$(node_major)" -ge "$MIN_NODE" ]; then
    info "Node.js $(node -v) · npm $(npm -v)"
    return
  fi
  if has node; then
    warn "Node.js $(node -v) es anterior a la $MIN_NODE que necesita Stratum."
  else
    warn "no se encontró Node.js."
  fi
  if confirm "¿Instalar Node.js 22 en $STRATUM_HOME/node (sin sudo, no toca el del sistema)?" s; then
    install_node
  else
    die "Stratum necesita Node.js $MIN_NODE o superior: instálalo (https://nodejs.org) o relanza con --yes."
  fi
}

# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------

# Primer ancestro existente de una ruta: es el que decide si se puede escribir.
writable_path() {
  p="$1"
  while [ ! -e "$p" ] && [ "$p" != "/" ]; do p=$(dirname "$p"); done
  [ -w "$p" ]
}

install_cli() {
  if [ -n "$CLI_VERSION" ]; then
    spec="$PACKAGE@$CLI_VERSION"
  elif [ "$CHANNEL" = beta ]; then
    spec="$PACKAGE@beta"
  else
    spec="$PACKAGE@latest"
  fi
  step "Instalando la CLI ($spec)"

  prefix=$(npm prefix -g 2>/dev/null) || prefix="$STRATUM_HOME/node"
  # Con el Node del sistema el prefijo global suele ser de root: se instala
  # en ~/.local en vez de pedir sudo para npm.
  if ! writable_path "$prefix/lib/node_modules" || ! writable_path "$prefix/bin"; then
    prefix="$HOME/.local"
    info "el prefijo global de npm no es escribible; se instala en $prefix"
    run npm install -g --prefix "$prefix" "$spec"
    in_path "$prefix/bin" || PATH_HINT=1
  else
    run npm install -g "$spec"
  fi

  STRATUM_BIN="$prefix/bin/stratum"
  if [ "$DRY_RUN" = 1 ]; then return; fi
  [ -x "$STRATUM_BIN" ] || die "npm terminó pero no dejó $STRATUM_BIN."
  if ! in_path "$prefix/bin"; then
    link_user_bin "$STRATUM_BIN" stratum
  fi
  info "stratum $("$STRATUM_BIN" --version 2>/dev/null || echo '?') en $STRATUM_BIN"
}

# -----------------------------------------------------------------------------
# Desktop
# -----------------------------------------------------------------------------

# Última release `desktop-v*` publicada. La «latest» de GitHub es la de la CLI,
# así que se recorre la lista (viene de más nueva a más antigua). En el canal
# estable se saltan las versiones con sufijo (-beta.N).
latest_desktop_version() {
  fetch "https://api.github.com/repos/$REPO/releases?per_page=100" |
    grep '"browser_download_url"' |
    sed -n 's|.*/releases/download/desktop-v\([^/]*\)/.*|\1|p' |
    if [ "$CHANNEL" = beta ]; then cat; else grep -v -- '-' || true; fi |
    head -n 1
}

install_desktop() {
  if [ "$OS" != linux ] || [ "$ARCH" != x64 ]; then
    warn "Stratum Desktop solo se publica para Linux x64 y Windows x64; se omite."
    return
  fi
  version="$DESKTOP_VERSION"
  if [ -z "$version" ]; then
    version=$(latest_desktop_version) || true
    [ -n "$version" ] || die "no se encontró ninguna release de Stratum Desktop en el canal $CHANNEL (prueba --channel beta)."
  fi

  format="$DESKTOP_FORMAT"
  SUDO=""
  if [ "$(id -u)" != 0 ]; then SUDO=sudo; fi
  if [ "$format" = auto ]; then
    if has apt-get && { [ -z "$SUDO" ] || has sudo; }; then format=deb; else format=appimage; fi
  fi
  case "$format" in
    deb) asset="Stratum_${version}_amd64.deb" ;;
    appimage) asset="Stratum_${version}_amd64.AppImage" ;;
    *) die "--desktop-format admite auto, deb o appimage." ;;
  esac

  step "Instalando Stratum Desktop $version ($format)"
  make_tmp
  base="https://github.com/$REPO/releases/download/desktop-v$version"
  if [ "$DRY_RUN" = 1 ]; then
    run download "$base/$asset" "$TMP_DIR/$asset"
  else
    download "$base/$asset" "$TMP_DIR/$asset" || die "no se pudo descargar $base/$asset"
    fetch "$base/SHA256SUMS.txt" >"$TMP_DIR/desktop-sums.txt" || die "la release no publica SHA256SUMS.txt."
    verify_sha256 "$TMP_DIR/$asset" "$TMP_DIR/desktop-sums.txt" "$asset"
  fi

  if [ "$format" = deb ]; then
    # apt resuelve las dependencias (webkit2gtk…); dpkg -i las dejaría rotas.
    chmod 755 "$TMP_DIR"
    info "apt necesita permisos de administrador"
    run $SUDO apt-get install -y "$TMP_DIR/$asset"
    info "instalado: lánzalo desde el menú de aplicaciones o con stratum-desktop"
    return
  fi

  app_dir="$HOME/.local/share/stratum-desktop"
  run mkdir -p "$app_dir" "$HOME/.local/share/applications"
  run mv "$TMP_DIR/$asset" "$app_dir/Stratum.AppImage"
  run chmod +x "$app_dir/Stratum.AppImage"
  link_user_bin "$app_dir/Stratum.AppImage" stratum-desktop
  if [ "$DRY_RUN" = 0 ]; then
    cat >"$HOME/.local/share/applications/stratum-desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Stratum
Comment=Stratum Desktop
Exec=$app_dir/Stratum.AppImage
Terminal=false
Categories=Development;Utility;
EOF
  fi
  if has ldconfig && ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    warn "un AppImage necesita FUSE 2 (en Debian/Ubuntu: sudo apt install libfuse2, o libfuse2t64)."
  fi
  info "instalado en $app_dir/Stratum.AppImage (se actualiza solo desde la app)"
}

# -----------------------------------------------------------------------------
# Configuración global
# -----------------------------------------------------------------------------

# Solo vale un `stratum` que arranque: en WSL, por ejemplo, el PATH trae el
# de Windows, que sin su Node no funciona.
find_stratum() {
  if [ -n "$STRATUM_BIN" ]; then return 0; fi
  for candidate in "$(command -v stratum 2>/dev/null || true)" "$USER_BIN/stratum" "$STRATUM_HOME/node/bin/stratum"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
      STRATUM_BIN="$candidate"
      return 0
    fi
  done
  return 1
}

# El alta la hace la propia CLI (valida, consulta /models y escribe de forma
# atómica). Se lanza desde ~/.stratum para que escriba la config global y no
# la de un proyecto que hubiera en el directorio actual.
stratum_global() {
  if [ "$DRY_RUN" = 1 ]; then
    run stratum "$@"
  else
    (cd "$STRATUM_HOME" && "$STRATUM_BIN" "$@")
  fi
}

install_config_file() {
  step "Instalando la configuración global desde $CONFIG_SOURCE"
  make_tmp
  case "$CONFIG_SOURCE" in
    http://* | https://*)
      fetch "$CONFIG_SOURCE" >"$TMP_DIR/stratumrc.json" || die "no se pudo descargar $CONFIG_SOURCE"
      ;;
    *)
      [ -f "$CONFIG_SOURCE" ] || die "no existe $CONFIG_SOURCE"
      cp "$CONFIG_SOURCE" "$TMP_DIR/stratumrc.json"
      ;;
  esac
  backup=""
  if [ -f "$GLOBAL_CONFIG" ]; then
    backup="$GLOBAL_CONFIG.bak-$(date +%Y%m%d%H%M%S)"
    run cp -p "$GLOBAL_CONFIG" "$backup"
    info "copia de la anterior: $backup"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    run cp "$TMP_DIR/stratumrc.json" "$GLOBAL_CONFIG"
    return
  fi
  (umask 077 && cp "$TMP_DIR/stratumrc.json" "$GLOBAL_CONFIG")
  chmod 600 "$GLOBAL_CONFIG"
  # La CLI es quien sabe si el fichero vale: si lo rechaza, se deshace.
  if find_stratum && ! stratum_global config get memory.globalFile >/dev/null 2>"$TMP_DIR/config-error.txt"; then
    if [ -n "$backup" ]; then cp -p "$backup" "$GLOBAL_CONFIG"; else rm -f "$GLOBAL_CONFIG"; fi
    cat "$TMP_DIR/config-error.txt" >&2
    die "la configuración no es válida; se ha dejado todo como estaba."
  fi
  info "escrita en $GLOBAL_CONFIG"
}

prompt_provider() {
  printf '\n%sProvider del modelo%s (cualquier API OpenAI-compatible)\n' "$C_BOLD" "$C_RESET" >/dev/tty
  cat >/dev/tty <<'EOF'
  1) Ollama       http://localhost:11434/v1
  2) llama.cpp    http://localhost:8080/v1
  3) LM Studio    http://localhost:1234/v1
  4) OpenAI       https://api.openai.com/v1
  5) Otra URL
EOF
  ask "Elige" "1"
  case "$REPLY" in
    1) BASE_URL="http://localhost:11434/v1"; alias_default=ollama ;;
    2) BASE_URL="http://localhost:8080/v1"; alias_default=llamacpp ;;
    3) BASE_URL="http://localhost:1234/v1"; alias_default=lmstudio ;;
    4) BASE_URL="https://api.openai.com/v1"; alias_default=openai ;;
    *)
      ask "URL base de la API (con /v1)" ""
      BASE_URL="$REPLY"
      alias_default=default
      ;;
  esac
  [ -n "$BASE_URL" ] || return 1
  ask "Alias del provider" "$alias_default"
  PROVIDER="$REPLY"
  ask_secret "API key (vacío si no hace falta; se guarda en claro en $GLOBAL_CONFIG)"
  API_KEY="$REPLY"
  ask "Modelo por defecto (vacío: se elige al arrancar)" ""
  MODEL="$REPLY"
}

configure_provider() {
  [ -n "$PROVIDER" ] || PROVIDER=default
  [ -n "$API_KEY" ] && [ -n "$API_KEY_ENV" ] && die "usa --api-key o --api-key-env, no los dos."
  step "Configurando el provider \"$PROVIDER\" ($BASE_URL)"
  run mkdir -p "$STRATUM_HOME"
  set -- provider add "$PROVIDER" --base-url "$BASE_URL" --default
  [ -n "$API_KEY_ENV" ] && set -- "$@" --api-key-env "$API_KEY_ENV"
  [ -n "$API_KEY" ] && set -- "$@" --api-key "$API_KEY"
  [ -n "$MODEL" ] && set -- "$@" --model "$MODEL"
  if [ "$DRY_RUN" = 1 ]; then
    # La key no se enseña ni en el simulacro.
    info "+ stratum provider add $PROVIDER --base-url $BASE_URL --default …"
    return
  fi
  if stratum_global "$@"; then
    [ -f "$GLOBAL_CONFIG" ] && chmod 600 "$GLOBAL_CONFIG"
    if [ -n "$API_KEY_ENV" ]; then
      info "recuerda exportar $API_KEY_ENV en tu shell (y en el entorno gráfico, para Desktop)"
    fi
  else
    warn "no se pudo configurar el provider; hazlo después con: stratum provider add"
  fi
}

configure() {
  [ "$SKIP_CONFIG" = 1 ] && return 0
  if [ -n "$CONFIG_SOURCE" ]; then
    run mkdir -p "$STRATUM_HOME"
    install_config_file
    return
  fi
  if [ -z "$BASE_URL" ]; then
    # Sin flags solo se pregunta en una instalación nueva: una config que ya
    # existe no se toca.
    if [ -f "$GLOBAL_CONFIG" ]; then
      info "ya hay configuración global en $GLOBAL_CONFIG; no se modifica"
      return
    fi
    interactive || return 0
    find_stratum || [ "$DRY_RUN" = 1 ] || return 0
    confirm "¿Configurar ahora el provider del modelo?" s || return 0
    prompt_provider || return 0
  fi
  if ! find_stratum && [ "$DRY_RUN" = 0 ]; then
    warn "la configuración la escribe la CLI y no está instalada; Stratum Desktop te guiará en su primer arranque."
    return
  fi
  configure_provider
}

# -----------------------------------------------------------------------------

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --desktop) INSTALL_DESKTOP=1 ;;
      --no-cli) INSTALL_CLI=0 ;;
      --no-config) SKIP_CONFIG=1 ;;
      -y | --yes) ASSUME_YES=1 ;;
      --dry-run) DRY_RUN=1 ;;
      -h | --help) usage; exit 0 ;;
      --channel | --version | --desktop-version | --desktop-format | --provider | --base-url | --api-key | --api-key-env | --model | --config)
        [ $# -ge 2 ] || die "falta el valor de $1."
        case "$1" in
          --channel) CHANNEL="$2" ;;
          --version) CLI_VERSION="$2" ;;
          --desktop-version) DESKTOP_VERSION="$2" ;;
          --desktop-format) DESKTOP_FORMAT="$2" ;;
          --provider) PROVIDER="$2" ;;
          --base-url) BASE_URL="$2" ;;
          --api-key) API_KEY="$2" ;;
          --api-key-env) API_KEY_ENV="$2" ;;
          --model) MODEL="$2" ;;
          --config) CONFIG_SOURCE="$2" ;;
        esac
        shift
        ;;
      *) die "opción desconocida: $1 (usa --help)." ;;
    esac
    shift
  done
  case "$CHANNEL" in
    stable | beta) ;;
    *) die "--channel admite stable o beta." ;;
  esac
  CLI_VERSION="${CLI_VERSION#v}"
  DESKTOP_VERSION="${DESKTOP_VERSION#v}"
}

main() {
  parse_args "$@"
  detect_platform
  printf '%sStratum%s · instalador (%s-%s)\n' "$C_BOLD" "$C_RESET" "$OS" "$ARCH"
  [ "$DRY_RUN" = 1 ] && info "simulacro: no se cambia nada"
  adopt_portable_node

  if [ "$INSTALL_CLI" = 1 ]; then
    step "Comprobando Node.js"
    ensure_node
    install_cli
  fi
  if [ "$INSTALL_DESKTOP" = 1 ]; then
    install_desktop
  fi
  configure

  printf '\n%sListo.%s\n' "$C_GREEN" "$C_RESET"
  if [ "$PATH_HINT" = 1 ]; then
    warn "añade $USER_BIN al PATH (y abre un terminal nuevo):"
    printf '    echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.profile\n' >&2
  fi
  if [ "$INSTALL_CLI" = 1 ]; then
    info "Empieza con:  stratum chat"
    [ -f "$GLOBAL_CONFIG" ] || info "Sin provider configurado todavía:  stratum provider add"
  fi
}

main "$@"
