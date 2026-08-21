#!/usr/bin/env bash
# Compila o projecto para produção.
# Correr na raiz do projecto: bash deploy/build-prod.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Carregar variáveis de ambiente se existir ficheiro .env
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

echo "==> Instalar dependências pnpm..."
pnpm install --frozen-lockfile

echo "==> Compilar servidor API..."
pnpm --filter @workspace/api-server run build

echo "==> Compilar site Net Serviços..."
BASE_PATH=/ NODE_ENV=production \
  pnpm --filter @workspace/net-servicos run build

echo ""
echo "✅ Build concluído."
echo "   API:  artifacts/api-server/dist/index.mjs"
echo "   Site: artifacts/net-servicos/dist/public/"
