import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { deriveRole, type PartRole } from './admin';
import {
  getEffectiveOrgScope,
  requireAuthOrScan,
} from '../middleware/scan-session';

export async function registerPartsRoutes(app: FastifyInstance) {
  // Flat BOM listing for an asset model — part metadata joined with
  // position refs and quantities from the bom_entries table. Gated on
  // auth-or-scan + scoped to the model's owner organization.
  app.get<{ Params: { modelId: string } }>(
    '/asset-models/:modelId/parts',
    { schema: { params: z.object({ modelId: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();

      const model = await db.query.assetModels.findFirst({
        where: eq(schema.assetModels.id, request.params.modelId),
      });
      if (!model) return reply.notFound();
      if (!scope.all && !scope.orgIds.includes(model.ownerOrganizationId)) {
        return reply.notFound();
      }

      const entries = await db.query.bomEntries.findMany({
        where: eq(schema.bomEntries.assetModelId, request.params.modelId),
      });
      if (entries.length === 0) return [];

      const partIds = [...new Set(entries.map((e) => e.partId))];
      const [parts, roleByPartId] = await Promise.all([
        db.query.parts.findMany({
          where: inArray(schema.parts.id, partIds),
        }),
        rolesForPartIds(db, partIds),
      ]);
      const partById = new Map(parts.map((p) => [p.id, p]));

      return entries.map((e) => {
        const p = partById.get(e.partId);
        return {
          bomEntryId: e.id,
          partId: e.partId,
          positionRef: e.positionRef,
          quantity: e.quantity,
          notes: e.notes,
          oemPartNumber: p?.oemPartNumber ?? null,
          displayName: p?.displayName ?? 'Unknown part',
          description: p?.description ?? null,
          crossReferences: p?.crossReferences ?? [],
          discontinued: p?.discontinued ?? false,
          imageUrl: p?.imageStorageKey ? storage.publicUrl(p.imageStorageKey) : null,
          role: roleByPartId.get(e.partId) ?? 'part',
        };
      });
    },
  );

  // Resources attached to a single part, scoped to a specific asset instance.
  // We scope by the instance's pinned ContentPackVersion so docs from other
  // versions don't leak in — each version has its own explicit author-curated
  // links, which is the whole point of authoring these at the version level.
  app.get<{
    Params: { partId: string };
    Querystring: { assetInstanceId: string };
  }>(
    '/parts/:partId/resources',
    {
      schema: {
        params: z.object({ partId: UuidSchema }),
        querystring: z.object({ assetInstanceId: UuidSchema }),
      },
    },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const { partId } = request.params;
      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.query.assetInstanceId),
        with: { site: true },
      });
      if (!instance) return reply.notFound('Asset instance not found.');
      // Gate by the instance's org — scan sessions are always bound to a
      // single asset, and authed users must own the instance's site.
      if (!scope.all && !scope.orgIds.includes(instance.site.organizationId)) {
        return reply.notFound('Asset instance not found.');
      }
      const pinnedVersionId = instance.pinnedContentPackVersionId;

      const part = await db.query.parts.findFirst({
        where: eq(schema.parts.id, partId),
      });
      if (!part) return reply.notFound('Part not found.');
      // Parts also carry an owner_organization_id. Same tenant guard.
      if (!scope.all && !scope.orgIds.includes(part.ownerOrganizationId)) {
        return reply.notFound('Part not found.');
      }

      // Components are part-of-part and aren't version-scoped — a motor
      // always has its bearings regardless of the asset's pinned content
      // pack version. Fetch these alongside the version-scoped resources.
      const componentLinks = await db.query.partComponents.findMany({
        where: eq(schema.partComponents.parentPartId, partId),
      });
      const childIds = [...new Set(componentLinks.map((l) => l.childPartId))];
      const [childParts, childRoles] = await Promise.all([
        childIds.length > 0
          ? db.query.parts.findMany({ where: inArray(schema.parts.id, childIds) })
          : Promise.resolve([] as Array<typeof schema.parts.$inferSelect>),
        rolesForPartIds(db, childIds),
      ]);
      const childById = new Map(childParts.map((p) => [p.id, p]));
      const components = componentLinks
        .map((l) => {
          const c = childById.get(l.childPartId);
          if (!c) return null;
          return {
            linkId: l.id,
            childPartId: c.id,
            oemPartNumber: c.oemPartNumber,
            displayName: c.displayName,
            description: c.description,
            positionRef: l.positionRef,
            quantity: l.quantity,
            orderingHint: l.orderingHint,
            imageUrl: c.imageStorageKey ? storage.publicUrl(c.imageStorageKey) : null,
            role: childRoles.get(c.id) ?? 'part',
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort(
          (a, b) =>
            a.orderingHint - b.orderingHint || a.displayName.localeCompare(b.displayName),
        );

      // Derive role for this part from part_components presence.
      const roleMap = await rolesForPartIds(db, [partId]);
      const role = roleMap.get(partId) ?? 'part';

      // No pinned version = no authored resources to show. Return the part
      // info + components (not version-scoped) so the PWA can still render
      // the detail view.
      if (!pinnedVersionId) {
        return {
          part: mapPart(part, storage, role),
          documents: [],
          trainingModules: [],
          components,
        };
      }

      // Join part_documents → documents → filter to pinned version. Same for
      // training. Two small queries — fine at this scale; if it grows we can
      // fold into a single JOIN.
      const [docLinks, moduleLinks] = await Promise.all([
        db.query.partDocuments.findMany({
          where: eq(schema.partDocuments.partId, partId),
        }),
        db.query.partTrainingModules.findMany({
          where: eq(schema.partTrainingModules.partId, partId),
        }),
      ]);

      const docIds = [...new Set(docLinks.map((l) => l.documentId))];
      const moduleIds = [...new Set(moduleLinks.map((l) => l.trainingModuleId))];

      const [linkedDocs, linkedModules] = await Promise.all([
        docIds.length > 0
          ? db.query.documents.findMany({
              where: inArray(schema.documents.id, docIds),
            })
          : Promise.resolve([] as Array<typeof schema.documents.$inferSelect>),
        moduleIds.length > 0
          ? db.query.trainingModules.findMany({
              where: inArray(schema.trainingModules.id, moduleIds),
            })
          : Promise.resolve([] as Array<typeof schema.trainingModules.$inferSelect>),
      ]);

      // Section-aware projection: for each linked doc, if it has authored
      // sections, emit only sections that link to this part (strict fallback).
      // A doc with sections-but-not-linking-to-this-part is omitted entirely.
      const docsForVersion = linkedDocs.filter(
        (d) => d.contentPackVersionId === pinnedVersionId,
      );
      const docIdsForSections = docsForVersion.map((d) => d.id);

      const allSectionsForDocs =
        docIdsForSections.length > 0
          ? await db.query.documentSections.findMany({
              where: inArray(schema.documentSections.documentId, docIdsForSections),
            })
          : [];

      // Which sections link to THIS part (filtered to the candidate pool)?
      const allSectionIds = allSectionsForDocs.map((s) => s.id);
      const partSectionLinks =
        allSectionIds.length > 0
          ? await db.query.partDocumentSections.findMany({
              where: and(
                eq(schema.partDocumentSections.partId, partId),
                inArray(schema.partDocumentSections.documentSectionId, allSectionIds),
              ),
            })
          : [];
      const linkedSectionIds = new Set(partSectionLinks.map((l) => l.documentSectionId));

      // Group sections by document, and bucket "doc has any sections" so we
      // can apply the strict-fallback omission rule.
      const sectionsByDoc = new Map<string, typeof allSectionsForDocs>();
      const docHasAnySections = new Set<string>();
      for (const s of allSectionsForDocs) {
        docHasAnySections.add(s.documentId);
        const arr = sectionsByDoc.get(s.documentId) ?? [];
        arr.push(s);
        sectionsByDoc.set(s.documentId, arr);
      }

      const documents = docsForVersion
        .map((d) => {
          const allSections = sectionsByDoc.get(d.id) ?? [];
          const hasSections = docHasAnySections.has(d.id);

          if (!hasSections) {
            // Legacy: doc has no authored sections. Render full doc on PWA.
            return {
              id: d.id,
              title: d.title,
              kind: d.kind,
              safetyCritical: d.safetyCritical,
              language: d.language,
              orderingHint: d.orderingHint,
              sections: null as ReturnType<typeof toPwaSection>[] | null,
            };
          }

          // Strict fallback: doc has sections; emit only those linking to
          // this part AND not flagged for re-validation.
          const linked = allSections
            .filter((s) => linkedSectionIds.has(s.id))
            .filter((s) => !s.needsRevalidation);
          if (linked.length === 0) return null; // omit doc entirely

          return {
            id: d.id,
            title: d.title,
            kind: d.kind,
            safetyCritical: d.safetyCritical,
            language: d.language,
            orderingHint: d.orderingHint,
            sections: linked
              .map(toPwaSection)
              .sort(comparePwaSections),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => a.orderingHint - b.orderingHint || a.title.localeCompare(b.title));

      const trainingModules = linkedModules
        .filter((m) => m.contentPackVersionId === pinnedVersionId)
        .map((m) => ({
          id: m.id,
          title: m.title,
          description: m.description,
          estimatedMinutes: m.estimatedMinutes,
          orderingHint: m.orderingHint,
        }))
        .sort((a, b) => a.orderingHint - b.orderingHint || a.title.localeCompare(b.title));

      return {
        part: mapPart(part, storage, role),
        documents,
        trainingModules,
        components,
      };
    },
  );
}

function mapPart(
  p: typeof schema.parts.$inferSelect,
  storage: { publicUrl: (key: string) => string },
  role: PartRole,
): {
  id: string;
  oemPartNumber: string;
  displayName: string;
  description: string | null;
  crossReferences: string[];
  discontinued: boolean;
  imageUrl: string | null;
  role: PartRole;
} {
  return {
    id: p.id,
    oemPartNumber: p.oemPartNumber,
    displayName: p.displayName,
    description: p.description,
    crossReferences: p.crossReferences,
    discontinued: p.discontinued,
    imageUrl: p.imageStorageKey ? storage.publicUrl(p.imageStorageKey) : null,
    role,
  };
}

// PWA-shape section DTO. Strips admin-only fields (needs_revalidation,
// revalidation_reason, audit metadata, ownership snapshots) so the PWA only
// gets what it needs to render. Tech users never see flagged sections —
// they're filtered out at the query layer above.
function toPwaSection(s: typeof schema.documentSections.$inferSelect): {
  id: string;
  kind: typeof s.kind;
  title: string;
  description: string | null;
  safetyCritical: boolean;
  orderingHint: number;
  pageStart: number | null;
  pageEnd: number | null;
  textPageHint: number | null;
  anchorExcerpt: string | null;
  anchorContextBefore: string | null;
  anchorContextAfter: string | null;
  timeStartSeconds: number | null;
  timeEndSeconds: number | null;
} {
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    description: s.description,
    safetyCritical: s.safetyCritical,
    orderingHint: s.orderingHint,
    pageStart: s.pageStart,
    pageEnd: s.pageEnd,
    textPageHint: s.textPageHint,
    anchorExcerpt: s.anchorExcerpt,
    anchorContextBefore: s.anchorContextBefore,
    anchorContextAfter: s.anchorContextAfter,
    timeStartSeconds: s.timeStartSeconds,
    timeEndSeconds: s.timeEndSeconds,
  };
}

// Sort sections within one document for the PWA: safety-critical first, then
// authoring order, then natural anchor position (pageStart / timeStart) so
// the rendering order is intuitive when ordering_hint is left at 0.
function comparePwaSections(
  a: ReturnType<typeof toPwaSection>,
  b: ReturnType<typeof toPwaSection>,
): number {
  if (a.safetyCritical !== b.safetyCritical) return a.safetyCritical ? -1 : 1;
  if (a.orderingHint !== b.orderingHint) return a.orderingHint - b.orderingHint;
  const aPos = a.pageStart ?? a.timeStartSeconds ?? 0;
  const bPos = b.pageStart ?? b.timeStartSeconds ?? 0;
  if (aPos !== bPos) return aPos - bPos;
  return a.title.localeCompare(b.title);
}

// Batch-derive the structural role for a set of part IDs. A single SQL query
// tells us which have children and which have parents in part_components;
// we project to a role map. No N+1 regardless of list size.
async function rolesForPartIds(
  db: import('@platform/db').Database,
  partIds: string[],
): Promise<Map<string, PartRole>> {
  const out = new Map<string, PartRole>();
  if (partIds.length === 0) return out;
  const idsLiteral = `{${partIds.join(',')}}`;
  const rows = (await db.execute(
    sql`SELECT p.id,
               EXISTS(SELECT 1 FROM part_components WHERE parent_part_id = p.id) AS has_children,
               EXISTS(SELECT 1 FROM part_components WHERE child_part_id = p.id) AS has_parent
        FROM parts p
        WHERE p.id = ANY(${idsLiteral}::uuid[])`,
  )) as unknown as Array<{ id: string; has_children: boolean; has_parent: boolean }>;
  for (const r of rows) {
    out.set(r.id, deriveRole(r.has_children, r.has_parent));
  }
  return out;
}
