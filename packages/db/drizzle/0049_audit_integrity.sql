-- Audit log integrity & scale hardening.
--
-- Turns audit_events from "append-only by convention" into a tamper-evident,
-- append-only-by-enforcement log:
--   * seq:        monotonic chain order + keyset-pagination cursor.
--   * request_id: correlate every event emitted while handling one request.
--   * prev_hash / row_hash: a per-org SHA-256 hash chain. A BEFORE INSERT
--     trigger links each new row to the previous row in the SAME org. Editing,
--     deleting, or reordering any historical row breaks every subsequent
--     row_hash, which audit_events_verify() detects.
--   * A BEFORE UPDATE / DELETE / TRUNCATE trigger rejects every mutation, so
--     the log is immutable regardless of which DB role connects (defense
--     beyond table GRANTs, which we cannot pin to a role name portably).
--
-- Concurrency: the INSERT trigger takes a per-org transaction-scoped advisory
-- lock so two concurrent inserts into the same org cannot read the same chain
-- tip and fork the chain. Different orgs never contend. The lock is released
-- when the (sub-millisecond) insert's implicit transaction commits.
--
-- Hand-written: drizzle-kit cannot model extensions/sequences/functions/
-- triggers, and the project's generated-snapshot history diverged at 0038.
-- All statements are idempotent so a partial/re-run apply is safe.

CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint

-- 1. Columns ----------------------------------------------------------------
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "seq" bigint;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "request_id" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "prev_hash" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "row_hash" text;--> statement-breakpoint

-- Sequence backing seq. OWNED BY the column so it is dropped with the table.
CREATE SEQUENCE IF NOT EXISTS "audit_events_seq" OWNED BY "audit_events"."seq";--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "seq" SET DEFAULT nextval('audit_events_seq');--> statement-breakpoint

-- 2. Canonical row digest ---------------------------------------------------
-- Single source of truth for the hash, shared by the insert trigger, the
-- backfill, and the verifier so they can never disagree. Field order and
-- separators are part of the contract: changing them re-defines the chain.
CREATE OR REPLACE FUNCTION audit_events_row_digest(
  p_prev_hash text,
  p_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_event_type text,
  p_target_type text,
  p_target_id uuid,
  p_payload jsonb,
  p_ip_address text,
  p_user_agent text,
  p_request_id text,
  p_occurred_at timestamptz,
  p_seq bigint
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(
    digest(
      coalesce(p_prev_hash, '') || E'\n' ||
      p_id::text || E'\n' ||
      p_organization_id::text || E'\n' ||
      coalesce(p_actor_user_id::text, '') || E'\n' ||
      p_event_type || E'\n' ||
      p_target_type || E'\n' ||
      coalesce(p_target_id::text, '') || E'\n' ||
      coalesce(p_payload::text, '{}') || E'\n' ||
      coalesce(p_ip_address, '') || E'\n' ||
      coalesce(p_user_agent, '') || E'\n' ||
      coalesce(p_request_id, '') || E'\n' ||
      to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || E'\n' ||
      p_seq::text,
      'sha256'
    ),
    'hex'
  );
$$;--> statement-breakpoint

-- 3. Backfill existing rows -------------------------------------------------
-- MUST run before the immutability trigger is installed (it issues UPDATEs).
-- Assign seq in a deterministic global order, then walk each org's rows in
-- seq order to build the chain from genesis.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM audit_events WHERE seq IS NULL ORDER BY occurred_at, id LOOP
    UPDATE audit_events SET seq = nextval('audit_events_seq') WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint

DO $$
DECLARE
  r RECORD;
  v_org uuid := NULL;
  v_prev text := NULL;
  v_hash text;
BEGIN
  FOR r IN SELECT * FROM audit_events ORDER BY organization_id, seq LOOP
    IF v_org IS DISTINCT FROM r.organization_id THEN
      v_org := r.organization_id;
      v_prev := NULL;  -- genesis row for this org
    END IF;
    v_hash := audit_events_row_digest(
      v_prev, r.id, r.organization_id, r.actor_user_id, r.event_type,
      r.target_type, r.target_id, r.payload, r.ip_address, r.user_agent,
      r.request_id, r.occurred_at, r.seq);
    UPDATE audit_events SET prev_hash = v_prev, row_hash = v_hash WHERE id = r.id;
    v_prev := v_hash;
  END LOOP;
END $$;--> statement-breakpoint

-- Every row now has a seq; enforce it for the future.
ALTER TABLE "audit_events" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint

-- 4. Insert trigger: assign seq + link the per-org hash chain ---------------
CREATE OR REPLACE FUNCTION audit_events_chain_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev text;
BEGIN
  -- Serialize inserts within an org so concurrent writers cannot read the
  -- same chain tip and fork it. Namespaced (key1) + per-org (key2); a hash
  -- collision across orgs only causes harmless extra serialization.
  PERFORM pg_advisory_xact_lock(hashtext('audit_events'), hashtext(NEW.organization_id::text));

  IF NEW.seq IS NULL THEN
    NEW.seq := nextval('audit_events_seq');
  END IF;

  SELECT row_hash INTO v_prev
  FROM audit_events
  WHERE organization_id = NEW.organization_id
  ORDER BY seq DESC
  LIMIT 1;

  NEW.prev_hash := v_prev;  -- NULL ⇒ genesis row for this org
  NEW.row_hash := audit_events_row_digest(
    v_prev, NEW.id, NEW.organization_id, NEW.actor_user_id, NEW.event_type,
    NEW.target_type, NEW.target_id, NEW.payload, NEW.ip_address, NEW.user_agent,
    NEW.request_id, NEW.occurred_at, NEW.seq);
  RETURN NEW;
END $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_events_chain_insert ON "audit_events";--> statement-breakpoint
CREATE TRIGGER audit_events_chain_insert
  BEFORE INSERT ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain_insert();--> statement-breakpoint

-- 5. Immutability: reject UPDATE / DELETE / TRUNCATE ------------------------
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only; % is not permitted', TG_OP
    USING ERRCODE = '23514';
END $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_events_no_update ON "audit_events";--> statement-breakpoint
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_no_delete ON "audit_events";--> statement-breakpoint
CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_no_truncate ON "audit_events";--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();--> statement-breakpoint

-- 6. Verifier ---------------------------------------------------------------
-- Returns one row per detected break (empty result ⇒ chain intact). Pass an
-- org id to verify a single tenant, or NULL for the whole table.
CREATE OR REPLACE FUNCTION audit_events_verify(p_org uuid DEFAULT NULL)
RETURNS TABLE(out_org uuid, out_seq bigint, out_reason text)
LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  v_org uuid := NULL;
  v_prev text := NULL;
  v_expected text;
BEGIN
  FOR r IN
    SELECT * FROM audit_events
    WHERE p_org IS NULL OR audit_events.organization_id = p_org
    ORDER BY audit_events.organization_id, audit_events.seq
  LOOP
    IF v_org IS DISTINCT FROM r.organization_id THEN
      v_org := r.organization_id;
      v_prev := NULL;
    END IF;
    IF r.prev_hash IS DISTINCT FROM v_prev THEN
      out_org := r.organization_id; out_seq := r.seq;
      out_reason := 'prev_hash linkage broken (row deleted or reordered)';
      RETURN NEXT;
    END IF;
    v_expected := audit_events_row_digest(
      r.prev_hash, r.id, r.organization_id, r.actor_user_id, r.event_type,
      r.target_type, r.target_id, r.payload, r.ip_address, r.user_agent,
      r.request_id, r.occurred_at, r.seq);
    IF r.row_hash IS DISTINCT FROM v_expected THEN
      out_org := r.organization_id; out_seq := r.seq;
      out_reason := 'row_hash mismatch (row contents tampered)';
      RETURN NEXT;
    END IF;
    v_prev := r.row_hash;
  END LOOP;
  RETURN;
END $$;--> statement-breakpoint

-- 7. Indexes (scale) --------------------------------------------------------
CREATE INDEX IF NOT EXISTS "audit_events_org_seq_idx" ON "audit_events" USING btree ("organization_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_seq_idx" ON "audit_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_request_idx" ON "audit_events" USING btree ("request_id");--> statement-breakpoint
-- BRIN keeps time-range scans cheap as the table grows into millions of rows;
-- audit_events is append-only and time-correlated, BRIN's ideal case.
CREATE INDEX IF NOT EXISTS "audit_events_occurred_brin" ON "audit_events" USING brin ("occurred_at");
