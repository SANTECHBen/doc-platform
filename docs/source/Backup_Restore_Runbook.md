# Backup & Restore Runbook

Operational runbook for verifying that Equipment Hub data is backed up, recoverable, and resilient before the beta program goes live. Run this checklist before sending the first beta agreement.

> **Owner:** SANTECH operations
> **Cadence:** Run pre-beta. Re-run quarterly.
> **Estimated time to complete first pass:** 3-5 hours

---

## What needs to be backed up

| Asset | Where it lives | Loss impact |
|-------|----------------|-------------|
| Postgres database | Neon (or Fly.io managed Postgres) | **Catastrophic** — work orders, audit log, training records, content metadata, all relationships |
| R2 object storage | Cloudflare R2 (`equipment-hub-media` bucket) | **High** — uploaded photos, documents, videos, schematic files |
| Tenant configuration | Postgres (organizations, qr_label_templates) | **Medium** — recoverable from DB backup |
| Authored content | Postgres + R2 | **High** — covered by the two above |
| Vercel project state | Vercel (config, env vars) | **Low** — re-deployable from `main` branch |
| Fly.io app state | Fly | **Low** — re-deployable from container image |

---

## 1 — Verify Postgres backup configuration

### If using Neon (recommended for production)

Neon performs continuous backup with point-in-time recovery up to a configurable retention window (7 days on free tier, 30+ on paid).

```bash
# List all branches and check the recovery point window
neonctl branches list

# Check current retention setting
neonctl projects get
```

**Confirm:**
- [ ] Branch retention is at least **7 days** (paid tier required for 14+ days)
- [ ] Auto-suspend is configured if cost-conscious, but minimum compute is `0.25` to keep it warm during beta
- [ ] Point-in-time recovery available for production branch

### If using Fly.io managed Postgres

```bash
# Verify daily snapshots are enabled
flyctl postgres list --app <postgres-app-name>
flyctl postgres snapshots --app <postgres-app-name>
```

**Confirm:**
- [ ] At least **3 daily snapshots** exist
- [ ] Snapshot age of newest is < 24 hours
- [ ] Volume size is at least 2x current data size (room to restore)

### Manual nightly dump (additional safety net for beta)

Schedule a nightly `pg_dump` to R2 for an independent backup. Recommended for the duration of the beta program.

```bash
# Run from any machine with DATABASE_URL set
pg_dump --format=custom --no-owner "$DATABASE_URL" \
  | aws s3 cp - "s3://equipment-hub-backups/db/$(date +%Y%m%d).dump" \
    --endpoint-url=$R2_ENDPOINT
```

**Confirm:**
- [ ] Cron job set up (manually, GitHub Actions, or Fly machine cron)
- [ ] Most recent dump < 25 hours old
- [ ] R2 bucket `equipment-hub-backups` has its own access keys (don't reuse `equipment-hub-media` keys)

---

## 2 — Test database restore (the actual drill)

A backup you've never restored is not a backup. Run this drill at least once before beta starts.

### Step-by-step restore drill

1. **Spin up an empty staging Postgres database.** Use a separate Neon project or a local Docker `postgres:16` for the drill.

2. **Pull the most recent dump** from R2 (or trigger a Neon branch from the recovery point).

   ```bash
   aws s3 cp s3://equipment-hub-backups/db/<latest>.dump ./latest.dump \
     --endpoint-url=$R2_ENDPOINT
   ```

3. **Restore into the staging DB.**

   ```bash
   pg_restore --no-owner --no-acl --dbname=postgres://staging-credentials ./latest.dump
   ```

4. **Verify the restore by running a few sanity queries.**

   ```sql
   SELECT count(*) FROM organizations;       -- non-zero
   SELECT count(*) FROM asset_instances;     -- non-zero
   SELECT count(*) FROM document_sections;   -- non-zero
   SELECT max(submitted_at) FROM feedback;   -- recent timestamp
   SELECT max(opened_at) FROM work_orders;   -- recent timestamp
   ```

5. **Spot-check a relationship** — pick a known asset instance from the source DB, verify it joins correctly to its site, organization, and content pack in the restored DB.

6. **Document the time it took.** A restore that takes more than 1 hour for the current data size means you need to revisit the backup format or compression.

**Confirm:**
- [ ] Restore drill completed within last 30 days
- [ ] Restore time < 30 minutes for current data size
- [ ] Sanity queries returned expected row counts
- [ ] At least one relationship spot-checked end-to-end

---

## 3 — Verify R2 object storage

### Enable versioning on the media bucket

R2 supports object versioning. Enable it on `equipment-hub-media` so accidental deletes are recoverable.

```bash
# Check current versioning status
aws s3api get-bucket-versioning \
  --bucket equipment-hub-media \
  --endpoint-url=$R2_ENDPOINT

# If "Status" is not "Enabled":
aws s3api put-bucket-versioning \
  --bucket equipment-hub-media \
  --versioning-configuration Status=Enabled \
  --endpoint-url=$R2_ENDPOINT
```

**Confirm:**
- [ ] Versioning is enabled
- [ ] Lifecycle rule deletes non-current versions after 90 days (avoid runaway storage cost)

### Verify CORS and bucket policies

The PWA fetches PDFs directly from R2 via CORS. Verify the configuration didn't drift:

```bash
aws s3api get-bucket-cors --bucket equipment-hub-media --endpoint-url=$R2_ENDPOINT
```

**Confirm CORS allows:**
- [ ] `https://hub.equipmenthub.io` (PWA prod)
- [ ] `https://equipment-hub-pwa.vercel.app` (Vercel preview)
- [ ] `https://equipment-hub-admin.vercel.app` (admin)
- [ ] Localhost origins for dev only — should NOT be in prod config

---

## 4 — Test object restore from R2

Pick one document upload, delete it, then restore from a prior version. This validates that versioning actually works end-to-end.

```bash
# 1. Upload a test object
echo "test" | aws s3 cp - s3://equipment-hub-media/restore-drill/test.txt \
  --endpoint-url=$R2_ENDPOINT

# 2. Update it (creates a new version)
echo "updated" | aws s3 cp - s3://equipment-hub-media/restore-drill/test.txt \
  --endpoint-url=$R2_ENDPOINT

# 3. List versions
aws s3api list-object-versions \
  --bucket equipment-hub-media \
  --prefix restore-drill/ \
  --endpoint-url=$R2_ENDPOINT

# 4. Restore the original by copying that version-id
aws s3api copy-object \
  --bucket equipment-hub-media \
  --copy-source "equipment-hub-media/restore-drill/test.txt?versionId=<original-version-id>" \
  --key restore-drill/test.txt \
  --endpoint-url=$R2_ENDPOINT

# 5. Clean up
aws s3 rm s3://equipment-hub-media/restore-drill/ --recursive \
  --endpoint-url=$R2_ENDPOINT
```

**Confirm:**
- [ ] Versions listed correctly
- [ ] Restore-by-copy succeeded
- [ ] Original content was retrievable

---

## 5 — Application-level recovery procedure

Document the actual playbook for when something goes wrong.

### Scenario A — accidental admin DELETE

Tenant admin (or SANTECH staff) deletes content that shouldn't have been deleted.

**Recovery path:**
1. Confirm with the customer: when did this happen? What got deleted?
2. Use Neon's point-in-time recovery to spin up a branch at a timestamp before the delete
3. Pull the deleted records from the branch (`SELECT * FROM <table> WHERE deleted_at IS NULL`)
4. Insert those records back into production
5. Notify the customer once recovery is complete

**Confirm:**
- [ ] Recovery procedure documented in customer-facing terms
- [ ] On-call contact knows where this runbook lives

### Scenario B — corrupted database

Hardware failure, schema corruption, or migration error breaks the database.

**Recovery path:**
1. Page on-call engineer immediately
2. Promote the latest snapshot or PITR branch to a new database
3. Update `DATABASE_URL` in Fly secrets and restart the API
4. Verify health endpoint responds: `curl https://equipment-hub-api.fly.dev/healthz`
5. Spot-check a tenant via PWA scan flow

**Estimated RTO (Recovery Time Objective):** < 1 hour
**Estimated RPO (Recovery Point Objective):** < 5 minutes (Neon PITR) or < 24 hours (snapshot only)

### Scenario C — bucket misconfigured / CORS broke

Cloudflare R2 config drift or accidentally-restrictive policy breaks PDF rendering in the PWA.

**Recovery path:**
1. Check current CORS config (command in section 3)
2. Restore from `infra/r2-cors-baseline.json` (committed to repo) — TODO commit this
3. Verify with browser dev tools: `Network` → check OPTIONS preflight on R2 URL

---

## 6 — Audit & sign-off

After completing the above:

| Item | Status | Date | Verified by |
|------|--------|------|-------------|
| Postgres backup configuration verified | | | |
| Restore drill completed | | | |
| R2 versioning enabled | | | |
| R2 CORS verified | | | |
| Object restore tested | | | |
| Recovery procedures documented | | | |
| Recovery procedures rehearsed (at least dry-run) | | | |

Sign and date this page. Re-run the restore drill quarterly. Re-verify CORS after any infrastructure change.

---

## Things to commit to the repo (follow-ups)

These aren't part of this runbook but emerged while writing it:

- [ ] `infra/r2-cors-baseline.json` — committed CORS config so drift is detectable
- [ ] `.github/workflows/nightly-pgdump.yml` — automated nightly dump to R2 (during beta only)
- [ ] `scripts/restore-drill.sh` — one-command restore drill against staging Postgres
- [ ] Update `docs/runbooks/README.md` to link to this document

---

## Contacts during a real incident

- **On-call engineer:** [name + phone]
- **Database escalation:** Neon support (paid plan only)
- **Storage escalation:** Cloudflare R2 support
- **Vercel/Fly.io operations:** [account owner]
- **Customer comms during outage:** [PR/customer success owner]

Update these before the beta program starts.
