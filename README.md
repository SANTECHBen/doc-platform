# doc-platform

Equipment-centric Connected Worker Platform for Material Handling & Industrial Automation.

Plan: `C:\Users\Ben\.claude\plans\a-and-b-fancy-flask.md`.

## Structure

```
apps/
  pwa/      Next.js PWA — QR-scan entry point (zero-install mobile web)
  native/   React Native tablet app (Expo) — offline-first    [Phase 2]
  admin/    Next.js admin web — authoring, tenants, analytics
packages/
  db/       Drizzle ORM schema, migrations, client
  shared/   Zod schemas + inferred types shared across apps
  ai/       Anthropic Claude SDK wrapper, RAG, guardrails
  api/      Fastify modular monolith API
```

## Prerequisites

- Node.js >= 20.11 (install from https://nodejs.org or via `nvm`)
- pnpm >= 9 (`npm i -g pnpm` after installing Node)
- PostgreSQL >= 16 with `pgvector` extension
- An Anthropic API key (for AI chat)

## First-time setup

```bash
pnpm install
cp .env.example .env.local
# edit .env.local with real values

# initialize DB schema
pnpm db:generate
pnpm db:migrate
```

## Dev

```bash
pnpm dev              # runs all apps in parallel via turbo
pnpm --filter @platform/api dev
pnpm --filter @platform/pwa dev
pnpm --filter @platform/admin dev
```

Default dev ports:
- PWA: http://localhost:3000
- API: http://localhost:3001
- Admin: http://localhost:3002

## The data model, briefly

- `Organization` — your tenant. Can be an OEM, a Dealer, or an End-Customer (three distinct types with different capabilities).
- `AssetModel` — the equipment SKU (e.g., "Dematic Multishuttle Gen 4").
- `AssetInstance` — a serial-numbered unit at a customer site. **The QR code resolves to an Asset Instance.**
- `ContentPack` — a versioned bundle of docs + training + parts authored against an `AssetModel`. OEM-authored base; dealers can fork/overlay.
- Content is authored once against the *Model*; users interact with the *Instance*. The asset instance pins a specific `ContentPack@version` for audit/compliance.

See `packages/db/src/schema/` for the full schema.

## Status

Phase 0 / early Phase 1 scaffold. See plan for milestones.
