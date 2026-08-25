# Net Serviços

Plataforma de venda de pacotes de dados e entrega USSD em Moçambique.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Payment env (server-only): `PAGAR_API_BASE_URL`, `PAGAR_API_KEY`, `PAGAR_SIGNING_SECRET`, `PAGAR_WEBHOOK_SECRET`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/services/pagar.ts` — Pagar API client, request signatures, persistence, and webhook verification
- `artifacts/api-server/src/routes/pagar.ts` — backend payment and webhook routes
- `lib/db/src/schema/index.ts` — PostgreSQL models for Pagar operations and webhook event deduplication
- `artifacts/api-server/legacy/zumbopay-bridge.js` — legacy UI/auth and internal order bridge; payment calls are delegated to the parent API

## Architecture decisions

- Pagar mutations are signed server-side with a fresh timestamp and nonce, and retried with the same idempotency key/body when applicable.
- A payment is released to the USSD delivery queue only after a validated Pagar webhook reports `PAID`; HTTP 202 is never treated as success.
- Legacy JSON orders/users remain compatible, while Pagar operations and webhook event IDs are persisted in PostgreSQL.

## Product

Users can buy data bundles, recharge internal credit, and send confirmed purchases to a paired USSD delivery device.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Pagar accepts integer MZN values from 20 through 40000. Existing bundles below 20 MZN are rejected by the backend rather than silently adjusted.
- Configure TEST credentials separately from LIVE credentials; never place Pagar secrets in browser variables, Git, URLs, or logs.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
