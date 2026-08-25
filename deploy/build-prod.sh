#!/usr/bin/env bash
# Compila o projecto para produção.
# Correr na raiz do projecto: bash deploy/build-prod.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Instalar com NODE_ENV=development para incluir devDependencies (esbuild, etc.)
echo "==> Instalar dependências pnpm..."
NODE_ENV=development pnpm install --no-frozen-lockfile

echo "==> Compilar servidor API..."
pnpm --filter @workspace/api-server run build

echo "==> Compilar site Megabyte..."
BASE_PATH=/ NODE_ENV=production \
  pnpm --filter @workspace/net-servicos run build

echo ""
echo "✅ Build concluído."
echo "   API:  artifacts/api-server/dist/index.mjs"
echo "   Site: artifacts/net-servicos/dist/public/"
