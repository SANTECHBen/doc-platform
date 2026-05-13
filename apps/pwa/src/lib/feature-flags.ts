// Client-side feature flags. Read once at module load; flip via Vercel
// env vars (Project → Settings → Environment Variables) and redeploy.
//
// Add flags here rather than scattering process.env reads through the
// codebase — keeps the list discoverable and the typecheck honest.

/** Run-with-evidence flow (ProcedureRunner) — the audit-trail mode
 *  that captures photos/measurements per step. The runner itself is
 *  always available; the flag only governs whether the "Run with
 *  evidence" entry button is shown on the procedure intro screen.
 *  Default: off. Flip per-customer when an OEM contract requires
 *  evidence capture by setting NEXT_PUBLIC_FEATURE_PROCEDURE_RUN=1. */
export const FEATURE_PROCEDURE_RUN_ENABLED =
  process.env.NEXT_PUBLIC_FEATURE_PROCEDURE_RUN === '1';
