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
  assetInstanceId: z.string().uuid().optional(),
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

      // If we know the QR code, look up the org for tenant segmentation.
      // Best-effort — failure to resolve doesn't block the submission.
      let resolvedOrgId: string | null = null;
      if (body.qrCode) {
        try {
          const qrRow = await db.query.qrCodes.findFirst({
            where: eq(schema.qrCodes.code, body.qrCode),
            with: { assetInstance: { with: { site: true } } },
          });
          resolvedOrgId = qrRow?.assetInstance?.site?.organizationId ?? null;
        } catch {
          // ignore — diagnostic only
        }
      }

      const [row] = await db
        .insert(schema.feedback)
        .values({
          message: body.message,
          category: body.category,
          qrCode: body.qrCode ?? null,
          assetInstanceId: body.assetInstanceId ?? null,
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
          body.qrCode ? `*QR:* \`${body.qrCode}\`` : null,
          body.assetInstanceId ? `*Asset:* \`${body.assetInstanceId}\`` : null,
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
