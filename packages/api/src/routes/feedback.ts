import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';

// Free-form category. Kept as text on the DB side so we can iterate during
// the beta without a migration.
const CategoryEnum = z.enum(['bug', 'feature', 'question', 'praise', 'other']);

const FeedbackBody = z.object({
  message: z.string().trim().min(1).max(5000),
  category: CategoryEnum.default('other'),
  qrCode: z.string().trim().min(1).max(64).optional(),
  // Note: `assetInstanceId` is intentionally NOT accepted from the body.
  // We derive it server-side from the caller's scan session — accepting
  // it from the body let any unauthenticated caller spoof attribution.
  contactEmail: z.string().email().max(254).optional(),
  // Diagnostic context — provided by the widget. All optional.
  browserUa: z.string().max(1000).optional(),
  viewport: z.object({ w: z.number().int(), h: z.number().int() }).optional(),
  appVersion: z.string().max(64).optional(),
});

export async function registerFeedbackRoutes(app: FastifyInstance) {
  // Open endpoint — no auth required. PWA is anonymous-by-design and the
  // beta widget needs to work for any tech who happens to be in the field.
  // Rate-limited at the load balancer; further hardening (captcha, IP
  // throttle) deferred until we see abuse.
  app.post(
    '/feedback',
    {
      schema: { body: FeedbackBody },
    },
    async (request, reply) => {
      const { db, env } = app.ctx;
      const body = request.body as z.infer<typeof FeedbackBody>;

      // Org/asset attribution is derived exclusively from the caller's auth
      // or scan session — NEVER from caller-asserted body fields. Without a
      // valid scan session or auth, the submission is accepted but stored
      // unattributed (anonymous "global" feedback). This prevents an open
      // endpoint from being abused to plant rows that look like real
      // customer activity (or to spray Slack with fake "Amazon DC tech said
      // …" messages).
      let resolvedOrgId: string | null = null;
      let resolvedAssetInstanceId: string | null = null;
      if (request.scanSession) {
        resolvedOrgId = request.scanSession.organizationId;
        resolvedAssetInstanceId = request.scanSession.assetInstanceId;
      } else if (request.auth) {
        resolvedOrgId = request.auth.organizationId;
      }
      // Only honor the qrCode hint when it matches the active scan session,
      // so a malicious submitter can't smuggle a foreign QR string into
      // their own org's feedback row.
      const persistedQrCode =
        body.qrCode &&
        request.scanSession &&
        body.qrCode === request.scanSession.qrCode
          ? body.qrCode
          : null;

      const [row] = await db
        .insert(schema.feedback)
        .values({
          message: body.message,
          category: body.category,
          qrCode: persistedQrCode,
          assetInstanceId: resolvedAssetInstanceId,
          orgId: resolvedOrgId,
          contactEmail: body.contactEmail ?? null,
          browserUa: body.browserUa ?? null,
          viewport: body.viewport ?? null,
          appVersion: body.appVersion ?? null,
        })
        .returning();

      // Sidecar to Slack if configured. Fire-and-forget so a slow Slack
      // doesn't block the user's submit.
      if (env.FEEDBACK_SLACK_WEBHOOK && row) {
        const summary = body.message.length > 200
          ? `${body.message.slice(0, 200)}…`
          : body.message;
        const ctx = [
          `*Category:* ${body.category}`,
          persistedQrCode ? `*QR:* \`${persistedQrCode}\`` : null,
          resolvedAssetInstanceId
            ? `*Asset:* \`${resolvedAssetInstanceId}\``
            : null,
          body.contactEmail ? `*Contact:* ${body.contactEmail}` : null,
          body.appVersion ? `*App:* ${body.appVersion}` : null,
        ].filter(Boolean).join(' · ');
        void fetch(env.FEEDBACK_SLACK_WEBHOOK, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: `:speech_balloon: *Beta feedback* (id: ${row.id})\n${ctx}\n\n>${summary}`,
          }),
        }).catch((err) => {
          app.log.warn({ err }, 'feedback: slack forward failed');
        });
      }

      return reply.code(201).send({ id: row?.id });
    },
  );
}
