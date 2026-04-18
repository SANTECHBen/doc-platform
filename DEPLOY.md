# Deploy — Hybrid (Vercel + Fly + Neon + R2)

Production shape:

```
apps/pwa   ─▶ Vercel        (Next.js edge + static)
apps/admin ─▶ Vercel        (Next.js)
packages/api ─▶ Fly.io      (Fastify + SSE)
   ├── Postgres ─▶ Neon     (serverless PG with pgvector)
   └── Object store ─▶ Cloudflare R2 (S3-compatible)
```

You don't have to follow the exact list of vendors — any Postgres-with-pgvector
provider works, and any S3-compatible bucket works — but the rest of this guide
assumes them.

---

## 0. Prerequisites

```bash
# One-time CLI installs
winget install --id Cloudflare.cloudflared
winget install --id Fly.Fly
npm install -g vercel
```

Accounts you'll need:
- **Neon** — https://neon.tech (free tier is plenty for early production)
- **Cloudflare** — for R2 (free tier includes 10 GB storage)
- **Fly.io** — https://fly.io (~$5/mo for a single small machine)
- **Vercel** — you already have one
- **Anthropic** — you already have the API key

---

## 1. Provision Postgres (Neon)

1. https://console.neon.tech → **New project**.
2. Enable the `vector` extension: in the SQL console, run:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. Copy the **connection string** (the "pooled" one is fine).  
   It looks like: `postgres://user:pw@ep-cool-river-123.us-east-2.aws.neon.tech/neondb?sslmode=require`

Keep this — you'll set it as `DATABASE_URL` in Fly.

---

## 2. Provision object storage (Cloudflare R2)

1. https://dash.cloudflare.com → R2 → **Create bucket**. Call it something like `equipment-hub-uploads`.
2. On the bucket → **Settings** → **Public access** → enable one of:
   - **Public R2.dev URL** (fine for MVP, looks like `https://pub-<hash>.r2.dev`), or
   - a custom domain (better for real production).
   Copy the public URL.
3. R2 dashboard → **Manage R2 API Tokens** → **Create API token** →
   - permission: **Object Read & Write**
   - scope: **this bucket only**
   - copy the **Access Key ID** and **Secret Access Key**
4. Note the R2 endpoint: `https://<your-account-id>.r2.cloudflarestorage.com`

You now have:
- `S3_BUCKET` — bucket name
- `S3_ENDPOINT` — the `*.r2.cloudflarestorage.com` URL above
- `S3_REGION` — `auto`
- `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` — from step 3
- `S3_PUBLIC_URL` — the public bucket URL from step 2

---

## 3. Deploy the API to Fly

All commands from the **repo root**, `C:\doc-platform`.

```bash
# First-time setup
flyctl auth login
flyctl apps create equipment-hub-api

# Secrets (never commit these)
flyctl secrets set --app equipment-hub-api \
  DATABASE_URL="postgres://...neondb?sslmode=require" \
  ANTHROPIC_API_KEY="sk-ant-..." \
  ANTHROPIC_MODEL="claude-opus-4-7" \
  PUBLIC_PWA_ORIGIN="https://hub.example.com" \
  PUBLIC_ADMIN_ORIGIN="https://admin.example.com" \
  S3_ENDPOINT="https://<acct>.r2.cloudflarestorage.com" \
  S3_REGION="auto" \
  S3_BUCKET="equipment-hub-uploads" \
  S3_ACCESS_KEY_ID="..." \
  S3_SECRET_ACCESS_KEY="..." \
  S3_PUBLIC_URL="https://pub-<hash>.r2.dev"

# Deploy — Dockerfile is at packages/api/Dockerfile but build context is the repo root.
flyctl deploy --config packages/api/fly.toml --dockerfile packages/api/Dockerfile
```

Fly will build the image, migrate the DB on boot, and start serving on your
Fly app's hostname (e.g. `https://equipment-hub-api.fly.dev`). Check health:

```bash
curl https://equipment-hub-api.fly.dev/health
# {"ok":true,"ts":"..."}
```

---

## 4. Deploy PWA + Admin to Vercel

Two separate Vercel projects, both pointed at this repo.

### PWA

```bash
cd apps/pwa
vercel link           # creates a new project or links existing
vercel env add NEXT_PUBLIC_API_BASE production
# paste: https://equipment-hub-api.fly.dev
vercel env add NEXT_PUBLIC_PWA_ORIGIN production
# paste: the Vercel URL you'll end up with (you'll know after first deploy — edit later)
vercel --prod
```

After first deploy, note the Vercel URL (e.g. `equipment-hub.vercel.app`). Go back
and set `NEXT_PUBLIC_PWA_ORIGIN` to it (or your custom domain when you assign one),
then redeploy.

### Admin

```bash
cd ../admin
vercel link
vercel env add NEXT_PUBLIC_API_BASE production
# same Fly URL as PWA
vercel env add NEXT_PUBLIC_PWA_ORIGIN production
# the PWA's Vercel URL — used to build QR sticker URLs in the admin UI
vercel --prod
```

Both Vercel projects' **root directory** should be the monorepo root, with
`rootDirectory: apps/pwa` (or `apps/admin`) set in the Vercel dashboard. The
included `vercel.json` in each app handles the turbo-based build command.

---

## 5. Wire everything together

After all three are deployed, update the API's `PUBLIC_PWA_ORIGIN` and
`PUBLIC_ADMIN_ORIGIN` Fly secrets to the real Vercel URLs — this is how the API's
CORS layer decides which origins to allow:

```bash
flyctl secrets set --app equipment-hub-api \
  PUBLIC_PWA_ORIGIN="https://hub.equipmenthub.io" \
  PUBLIC_ADMIN_ORIGIN="https://admin.equipmenthub.io"
```

Fly will redeploy automatically.

---

## 6. Custom domains (optional for launch, required for customers)

- **PWA** → Vercel project → Domains → add `hub.yourdomain.com`. Follow DNS instructions (CNAME).
- **Admin** → same → `admin.yourdomain.com`.
- **API** → Fly → `flyctl certs add api.yourdomain.com` then point a CNAME.

Update `NEXT_PUBLIC_API_BASE`, `PUBLIC_PWA_ORIGIN`, `PUBLIC_ADMIN_ORIGIN` to the
real domains after DNS is in place. Reverify QR code stickers: mint a fresh one
post-domain change; the admin renders URLs using `PUBLIC_PWA_ORIGIN`, so new
stickers will encode the real domain. Old stickers still point to the Vercel
preview URL — you can manually redirect or mint again.

---

## 7. Open work before real customer data lands

These are still on the "no-go-live" list even after deploy:

- [ ] **WorkOS / real auth** — still using the dev-user header. Add before any
      customer's technician touches it.
- [ ] **Rate limit `/ai/chat`** — Anthropic usage costs real money; a runaway
      loop burns credit. `@fastify/rate-limit` in 10 minutes.
- [ ] **Backup schedule on Neon** — free tier has daily backups; Pro lets you
      configure PITR.
- [ ] **Error tracking** — Sentry works out of the box with both Next.js and
      Fastify.
- [ ] **Anthropic cost alerts** — set a monthly cap in the Anthropic console.
- [ ] **Cloudflare WAF / rate limit** in front of R2 if you enabled public URL.

---

## 8. Quick sanity checklist

After deploy, walk through:

1. Open the admin Vercel URL — page renders, sidebar loads.
2. Open the PWA Vercel URL — landing page renders.
3. Admin → create an organization, asset model, content pack (draft), upload a PDF document, publish, mint a QR code. All of those hit Fly+R2+Neon.
4. Scan the QR with your phone — the asset hub loads over HTTPS, camera works in `/scan`.
5. Assistant tab — ask a question; confirm streaming works and citations come back.
6. Issues → Report → Take photo → confirm it uploads to R2 and shows up in the admin work orders page.
