FROM node:22-slim AS base
WORKDIR /app

# qpdf — used by the PDF extraction pipeline to split large PDFs on disk
# without loading the whole structure in memory. ~3 MB installed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends qpdf \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Monorepo manifests first — enables layer caching of the install step.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/api/package.json       packages/api/
COPY packages/db/package.json        packages/db/
COPY packages/ai/package.json        packages/ai/
COPY packages/shared/package.json    packages/shared/

RUN pnpm install --frozen-lockfile --prod=false

# Copy source after deps are in place.
COPY packages/api      packages/api
COPY packages/db       packages/db
COPY packages/ai       packages/ai
COPY packages/shared   packages/shared

ENV NODE_ENV=production
WORKDIR /app/packages/api
EXPOSE 3001

# We run via tsx so workspace TypeScript packages resolve directly from source —
# no dual-package conditional exports required. Slight startup cost, unlimited
# runtime. Fine for a Fastify server.
CMD ["pnpm", "start:prod"]
