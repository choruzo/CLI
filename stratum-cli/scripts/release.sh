#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────
# Uso: npm run release -- <tipo>
# Tipos: patch | minor | major | beta
# ──────────────────────────────────────────────

TYPE=${1:-""}

usage() {
  echo ""
  echo "  Uso: npm run release -- <tipo>"
  echo ""
  echo "  Tipos:"
  echo "    patch   vX.Y.Z → vX.Y.(Z+1)          (bug fixes)"
  echo "    minor   vX.Y.Z → vX.(Y+1).0           (nuevas features)"
  echo "    major   vX.Y.Z → v(X+1).0.0           (breaking changes)"
  echo "    beta    vX.Y.Z → vX.Y.Z-beta.N        (pre-release)"
  echo ""
  exit 1
}

case "$TYPE" in
  patch|minor|major|beta) ;;
  *) usage ;;
esac

# ── Validaciones previas ──────────────────────

echo ""
echo "▶  Validando entorno..."

# Árbol de trabajo limpio
if [ -n "$(git status --porcelain)" ]; then
  echo "✗  Hay cambios sin commitear. Haz commit o stash antes de hacer release."
  exit 1
fi

# Rama main
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "✗  Debes estar en 'main' para publicar (rama actual: '$BRANCH')."
  exit 1
fi

# Sincronizado con origin
git fetch --quiet origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "✗  La rama local no está sincronizada con origin/main. Haz pull primero."
  exit 1
fi

echo "✓  Entorno validado"

# ── CI local ──────────────────────────────────

echo ""
echo "▶  Ejecutando checks de CI..."
npm run build
npm test -- --run
npm run lint
echo "✓  Build, tests y lint pasaron"

# ── Bump de versión ───────────────────────────

echo ""
echo "▶  Bumpeando versión ($TYPE)..."

if [ "$TYPE" = "beta" ]; then
  npm version prerelease --preid=beta -m "chore: release v%s"
else
  npm version "$TYPE" -m "chore: release v%s"
fi

VERSION=$(node -p "require('./package.json').version")
echo "✓  Versión → $VERSION"

# ── Push ──────────────────────────────────────

echo ""
echo "▶  Pusheando commit y tag v$VERSION..."
git push && git push --tags

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Tag v$VERSION pusheado."
echo "  El workflow de GitHub Actions se ha disparado."
echo "  Progreso: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/actions"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
