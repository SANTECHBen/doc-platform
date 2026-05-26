FROM node:22-slim AS base
WORKDIR /app

# System binaries used by the extraction worker for PPTX → slide-image
# rendering. LibreOffice (Impress only) converts PPTX → PDF; Poppler's
# pdftoppm rasterizes each PDF page to a PNG; ffmpeg's ffprobe measures
# uploaded voiceover MP3 durations. fonts-liberation gives a serviceable
# default font set so decks built with Calibri/Arial still render legibly.
#
# Both Fly process groups (app + worker) share this image so we accept the
# ~280 MB image-size cost rather than maintaining a separate worker
# Dockerfile. The app process never *calls* these binaries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      poppler-utils \
      ffmpeg \
      fonts-liberation \
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
