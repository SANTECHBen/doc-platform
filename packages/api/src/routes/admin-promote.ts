// Promote AI conversation answer → authored procedure draft.
//
// One-tap flow that takes a great AI response and seeds an authored
// `structured_procedure` document with the parsed step list. The admin
// then refines, attaches media, generates voiceover, and publishes.
//
// This is the load-bearing piece that makes the authored-content-only
// strategy scale: AI does the first draft, human curates. Drops authoring
// time from ~30 minutes to ~5.
//
//   POST /admin/procedures/from-ai-message
//   body: { messageId: UUID, title?: string }
//   →    { documentId, stepCount, draftCreated }

import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';

const PromoteBody = z.object({
  messageId: UuidSchema,
  // Optional explicit title override. When omitted we infer from the
  // user's preceding question and the message structure.
  title: z.string().min(1).max(200).optional(),
});

interface ParsedStep {
  title: string;
  bodyMarkdown: string | null;
  safetyCritical: boolean;
}

interface ParsedProcedure {
  title: string;
  steps: ParsedStep[];
  // True when we found explicit list/heading structure. False = whole
  // message ended up as a single step (admin will split it).
  hadStructure: boolean;
}

// ---------------------------------------------------------------------------
// Step parser
// ---------------------------------------------------------------------------
//
// Tries, in order:
//   1. Numbered lists: 1. ... / 1) ... / 1: ...
//   2. "**Step N:**" or "Step N:" patterns
//   3. Bulleted lists: -, *, •
//   4. Section headings (## or ###) as step boundaries
//   5. Fallback: the whole message is one step
//
// Safety detection: any step containing LOCKOUT/TAGOUT, "lock out", "tag
// out", "PPE", "personal protective", "shock", "voltage", or sitting
// inside a "**Safety**"/"**Warning**" section is flagged safetyCritical.

const SAFETY_KEYWORDS_RE =
  /\b(lockout[\s-]*tagout|lock[\s-]?out|tag[\s-]?out|loto\b|ppe\b|personal protective|electrical (?:shock|hazard|isolat)|voltage|de-?energi[sz]e|line of fire|hot work|confined space|fall protection)\b/i;

function detectSafety(text: string, sectionContext: string | null): boolean {
  if (sectionContext) {
    if (/safety|warning|caution|danger|hazard/i.test(sectionContext)) return true;
  }
  return SAFETY_KEYWORDS_RE.test(text);
}

function stripCitations(text: string): string {
  return text.replace(/\[cite:[a-f0-9-]{8,}\]/gi, '').trim();
}

function tryNumberedList(text: string): ParsedStep[] | null {
  // Match any of: "1. text", "1) text", "1: text" at start of a line, or
  // following a paragraph break. Sorted by appearance.
  const re = /(?:^|\n)\s*(?:\*\*\s*)?(?:Step\s+)?(\d{1,3})[.\)\:]\s*(?:\*\*\s*)?(.+?)(?=(?:\n\s*(?:\*\*\s*)?(?:Step\s+)?\d{1,3}[.\)\:])|$)/gis;
  const items: ParsedStep[] = [];
  // Detect surrounding section heading for safety inheritance.
  let lastSection: string | null = null;
  const headingRe = /(?:^|\n)\s*(?:#{1,4}\s+|\*\*)([^\n*]+?)(?:\*\*)?\s*(?:\n|:)/g;
  for (const sm of text.matchAll(headingRe)) {
    if (sm[1]) lastSection = sm[1];
  }
  for (const m of text.matchAll(re)) {
    const raw = m[2]?.trim();
    if (!raw) continue;
    const { title, body } = splitTitleAndBody(raw);
    items.push({
      title: title.slice(0, 200),
      bodyMarkdown: body,
      safetyCritical: detectSafety(`${title} ${body ?? ''}`, lastSection),
    });
  }
  return items.length >= 2 ? items : null;
}

function tryBulletList(text: string): ParsedStep[] | null {
  const re = /(?:^|\n)\s*[-*•]\s+(.+?)(?=\n\s*[-*•]\s|\n\n|$)/gs;
  const items: ParsedStep[] = [];
  for (const m of text.matchAll(re)) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    const { title, body } = splitTitleAndBody(raw);
    items.push({
      title: title.slice(0, 200),
      bodyMarkdown: body,
      safetyCritical: detectSafety(`${title} ${body ?? ''}`, null),
    });
  }
  return items.length >= 2 ? items : null;
}

// Split a step's raw text into a short title (first sentence or up to a
// colon) and the rest as body. Keeps the runner card readable; long bodies
// flow into the secondary text area.
function splitTitleAndBody(raw: string): { title: string; body: string | null } {
  // If the text starts with bold "**Title** — body" or "**Title**: body",
  // pull the bolded segment as title.
  const boldLead = /^\*\*([^*]{3,80})\*\*\s*[—:\-]?\s*([\s\S]*)$/.exec(raw);
  if (boldLead) {
    const t = boldLead[1]!.trim();
    const b = boldLead[2]?.trim();
    return { title: t, body: b ? b : null };
  }
  // First sentence ending in a period, or first 120 chars.
  const colon = raw.indexOf(': ');
  if (colon > 8 && colon < 80) {
    return {
      title: raw.slice(0, colon).trim(),
      body: raw.slice(colon + 2).trim() || null,
    };
  }
  const period = /[.?!]\s/.exec(raw);
  if (period && period.index > 12 && period.index < 140) {
    return {
      title: raw.slice(0, period.index + 1).trim(),
      body: raw.slice(period.index + 2).trim() || null,
    };
  }
  // No obvious split — title is the whole thing if short, else first 120.
  if (raw.length <= 200) return { title: raw, body: null };
  return { title: raw.slice(0, 200).trim(), body: raw.slice(200).trim() };
}

function inferTitle(messageBody: string, userQuestion: string | null): string {
  // Prefer the first heading.
  const h = /^\s*#{1,4}\s+(.+?)\s*$/m.exec(messageBody);
  if (h && h[1]) return h[1].slice(0, 180).trim();

  const bold = /^\s*\*\*([^*\n]{3,80})\*\*/m.exec(messageBody);
  if (bold && bold[1]) return bold[1].trim();

  // Fall back to the user's question, with a "How to" tilt.
  if (userQuestion) {
    let t = userQuestion.replace(/^how (?:do|can) (?:i|we|you)\s+/i, '').replace(/\?$/, '').trim();
    if (t.length > 4) {
      // Capitalize first letter for title-case feel.
      t = t.charAt(0).toUpperCase() + t.slice(1);
      return t.slice(0, 180);
    }
  }
  return 'New procedure';
}

export function parseAiMessageToProcedure(input: {
  messageBody: string;
  userQuestion: string | null;
  titleOverride?: string;
}): ParsedProcedure {
  const cleaned = stripCitations(input.messageBody);
  const numbered = tryNumberedList(cleaned);
  const bulleted = !numbered ? tryBulletList(cleaned) : null;
  const steps = numbered ?? bulleted;
  if (steps && steps.length > 0) {
    return {
      title: input.titleOverride ?? inferTitle(cleaned, input.userQuestion),
      steps,
      hadStructure: true,
    };
  }
  // No structure — fall back to single step the admin will split.
  return {
    title: input.titleOverride ?? inferTitle(cleaned, input.userQuestion),
    steps: [
      {
        title: 'Review and split into steps',
        bodyMarkdown: cleaned,
        safetyCritical: detectSafety(cleaned, null),
      },
    ],
    hadStructure: false,
  };
}

// ---------------------------------------------------------------------------
// Pack version selection
// ---------------------------------------------------------------------------

async function findOrFailDraftVersion(
  db: Database,
  contentPackVersionId: string,
): Promise<
  | {
      ok: true;
      packVersionId: string;
      packId: string;
      ownerOrganizationId: string;
    }
  | { ok: false; reason: string }
> {
  // Start with the version the conversation was pinned to.
  const pinned = await db.query.contentPackVersions.findFirst({
    where: eq(schema.contentPackVersions.id, contentPackVersionId),
    with: { pack: true },
  });
  if (!pinned) return { ok: false, reason: 'Pinned content pack version not found.' };

  // If pinned is a draft, write into it directly.
  if (pinned.status === 'draft') {
    return {
      ok: true,
      packVersionId: pinned.id,
      packId: pinned.contentPackId,
      ownerOrganizationId: pinned.pack.ownerOrganizationId,
    };
  }

  // Otherwise look for a NEWER draft on the same pack.
  const newerDraft = await db.query.contentPackVersions.findFirst({
    where: and(
      eq(schema.contentPackVersions.contentPackId, pinned.contentPackId),
      eq(schema.contentPackVersions.status, 'draft'),
    ),
    orderBy: [desc(schema.contentPackVersions.versionNumber)],
  });
  if (newerDraft) {
    return {
      ok: true,
      packVersionId: newerDraft.id,
      packId: newerDraft.contentPackId,
      ownerOrganizationId: pinned.pack.ownerOrganizationId,
    };
  }

  return {
    ok: false,
    reason: `No draft version of "${pinned.pack.name}" exists. Create a new draft from the Content Packs page, then promote again.`,
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function registerAdminPromoteRoutes(app: FastifyInstance) {
  app.post<{ Body: z.infer<typeof PromoteBody> }>(
    '/admin/procedures/from-ai-message',
    { schema: { body: PromoteBody } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      if (!auth.platformAdmin) {
        // Per-org admins can also promote; this gate is only intentionally
        // restrictive on the cross-org scope. We still scope by org below.
      }
      const scope = await getScope(request, db);

      const message = await db.query.aiMessages.findFirst({
        where: eq(schema.aiMessages.id, request.body.messageId),
      });
      if (!message) return reply.notFound('AI message not found.');
      if (message.role !== 'assistant') {
        return reply.badRequest('Only assistant messages can be promoted.');
      }

      const conversation = await db.query.aiConversations.findFirst({
        where: eq(schema.aiConversations.id, message.conversationId),
      });
      if (!conversation) return reply.notFound('Conversation not found.');

      // The conversation is tied to an asset, which belongs to a site, which
      // belongs to an org. Only allow promoting if the caller can see that org.
      const asset = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, conversation.assetInstanceId),
        with: { site: true },
      });
      if (!asset) return reply.notFound('Asset not found.');
      requireOrgInScope(scope, asset.site.organizationId);

      // Find the user's preceding question for title inference. The
      // immediately-prior user message in the same conversation.
      const userMessages = await db.query.aiMessages.findMany({
        where: eq(schema.aiMessages.conversationId, conversation.id),
        orderBy: [desc(schema.aiMessages.createdAt)],
        limit: 10,
      });
      const idx = userMessages.findIndex((m) => m.id === message.id);
      const userQuestion =
        idx >= 0
          ? userMessages.slice(idx + 1).find((m) => m.role === 'user')?.content ?? null
          : null;

      const draft = await findOrFailDraftVersion(db, conversation.contentPackVersionId);
      if (!draft.ok) return reply.code(409).send({ error: draft.reason });

      const parsed = parseAiMessageToProcedure({
        messageBody: message.content,
        userQuestion,
        ...(request.body.title ? { titleOverride: request.body.title } : {}),
      });

      // Create the procedure document.
      const [doc] = await db
        .insert(schema.documents)
        .values({
          contentPackVersionId: draft.packVersionId,
          kind: 'structured_procedure',
          title: parsed.title,
          bodyMarkdown: null,
          language: 'en',
          safetyCritical: parsed.steps.some((s) => s.safetyCritical),
          tags: ['ai-promoted'],
          extractionStatus: 'not_applicable',
          procedureMetadata: {
            toolsRequired: [],
            safety: { enabled: parsed.steps.some((s) => s.safetyCritical), notes: null },
            verification: { enabled: false, notes: null },
          },
        })
        .returning();
      if (!doc) return reply.internalServerError('Failed to create procedure document.');

      // Insert steps with stride-100 ordering for clean drag-reorder later.
      let order = 100;
      for (const s of parsed.steps) {
        await db.insert(schema.procedureSteps).values({
          documentId: doc.id,
          kind: s.safetyCritical ? 'safety_check' : 'instruction',
          title: s.title,
          bodyMarkdown: s.bodyMarkdown,
          safetyCritical: s.safetyCritical,
          orderingHint: order,
          requiresPhoto: false,
          minPhotoCount: 0,
          measurementSpec: null,
          createdByUserId: auth.userId,
        });
        order += 100;
      }

      await db.insert(schema.auditEvents).values({
        organizationId: draft.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure.promoted_from_ai',
        targetType: 'document',
        targetId: doc.id,
        payload: {
          aiMessageId: message.id,
          conversationId: conversation.id,
          stepCount: parsed.steps.length,
          hadStructure: parsed.hadStructure,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.send({
        documentId: doc.id,
        packVersionId: draft.packVersionId,
        title: parsed.title,
        stepCount: parsed.steps.length,
        hadStructure: parsed.hadStructure,
      });
    },
  );
}
