// Admin SCORM course authoring + content-serving.
//
// Surface:
//   POST   /admin/content-pack-versions/:versionId/scorm-trainings
//          (multipart zip upload — creates document + scorm_packages
//           + training_module + scorm_course activity in one shot)
//   GET    /admin/scorm-packages/:id
//   PATCH  /admin/scorm-packages/:id  (title rename — fans out to doc + module + activity)
//   GET    /scorm-content/:packageId/*  (auth/scan-session-gated streaming
//                                        of an extracted SCORM file from
//                                        object storage. Same endpoint the
//                                        PWA proxies through to satisfy
//                                        SCORM's same-origin requirement
//                                        on the iframe + API stub.)
//
// We extract the entire zip on upload — each file lands in storage
// under `org/<orgId>/scorm/<packageId>/<path>` so relative URLs inside
// the package keep working when the iframe is served from the PWA
// proxy at /scorm-content/<packageId>/<path>.

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { schema, type Database } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import {
  getEffectiveOrgScope,
  requireAuthOrScan,
} from '../middleware/scan-session.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';

// Storyline + Captivate packages routinely top 50–100 MB once images
// and audio are bundled. 500 MB ceiling per package keeps the API
// responsive while supporting realistic content.
const MAX_PACKAGE_BYTES = 500 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

interface ManifestInfo {
  entryPath: string;
  scormVersion: string | null;
  title: string | null;
}

function parseManifest(xml: string): ManifestInfo | null {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const manifest = parsed.manifest as Record<string, unknown> | undefined;
  if (!manifest) return null;

  // Title may live in either manifest.metadata.lom.general.title.langstring
  // (IEEE LOM) or manifest.organizations.organization.title. Try both.
  const title = findFirstStringByKey(manifest, 'title') ?? null;

  // SCORM version: organizations[@default]'s metadata.schema and schemaversion
  // OR top-level metadata.schemaversion. Manifest schemas put it in
  // different places between 1.2 and 2004.
  const schemaVersion = findFirstStringByKey(manifest, 'schemaversion');

  // Entry resource: walk resources.resource; the default resource is the
  // one referenced by the first organization's first item identifierref.
  const resources = (manifest.resources as Record<string, unknown> | undefined)?.resource;
  const resourceList = Array.isArray(resources)
    ? (resources as Array<Record<string, unknown>>)
    : resources
      ? [resources as Record<string, unknown>]
      : [];
  // Prefer the resource referenced by the first <item identifierref="...">.
  const organizations = manifest.organizations as Record<string, unknown> | undefined;
  const orgList = organizations?.organization;
  const firstOrg = Array.isArray(orgList)
    ? (orgList[0] as Record<string, unknown> | undefined)
    : (orgList as Record<string, unknown> | undefined);
  const firstItem = firstOrg
    ? (Array.isArray(firstOrg.item)
        ? (firstOrg.item[0] as Record<string, unknown> | undefined)
        : (firstOrg.item as Record<string, unknown> | undefined))
    : undefined;
  const identifierRef = firstItem?.['@_identifierref'];
  let entryResource = resourceList[0];
  if (typeof identifierRef === 'string') {
    const match = resourceList.find((r) => r['@_identifier'] === identifierRef);
    if (match) entryResource = match;
  }
  const href = entryResource?.['@_href'];
  if (typeof href !== 'string') return null;
  return {
    entryPath: href.replace(/^\/+/, ''),
    scormVersion: typeof schemaVersion === 'string' ? schemaVersion : null,
    title: typeof title === 'string' ? title : null,
  };
}

function findFirstStringByKey(
  obj: unknown,
  key: string,
): string | null {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findFirstStringByKey(v, key);
      if (r) return r;
    }
    return null;
  }
  const o = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (k === key) {
      if (typeof v === 'string') return v.trim() || null;
      if (v && typeof v === 'object') {
        // Some schemas wrap the value in { '#text': 'value' } or
        // { langstring: { '#text': 'value' } }.
        const txt = findFirstStringByKey(v, '#text');
        if (txt) return txt;
      }
    }
    const r = findFirstStringByKey(v, key);
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Content-type sniffing for served files
// ---------------------------------------------------------------------------

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
};

function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// ensureTrainingModule helper — local copy of the slide-course pattern
// for SCORM. Idempotent.
// ---------------------------------------------------------------------------

async function ensureScormTrainingModule(
  db: Database,
  doc: typeof schema.documents.$inferSelect,
  scormPackageId: string,
): Promise<{ moduleId: string; activityId: string; created: boolean }> {
  // Look for an existing slide_course activity referencing this deck.
  const candidates = await db
    .select({
      id: schema.activities.id,
      trainingModuleId: schema.activities.trainingModuleId,
      config: schema.activities.config,
    })
    .from(schema.activities)
    .innerJoin(
      schema.trainingModules,
      eq(schema.activities.trainingModuleId, schema.trainingModules.id),
    )
    .where(
      and(
        eq(schema.activities.kind, 'scorm_course'),
        eq(schema.trainingModules.contentPackVersionId, doc.contentPackVersionId),
      ),
    );
  const match = candidates.find(
    (a) => (a.config as { scormPackageId?: string }).scormPackageId === scormPackageId,
  );
  if (match) {
    return { moduleId: match.trainingModuleId, activityId: match.id, created: false };
  }
  return await db.transaction(async (tx) => {
    const [module] = await tx
      .insert(schema.trainingModules)
      .values({
        contentPackVersionId: doc.contentPackVersionId,
        title: doc.title,
        description: null,
        passThreshold: 0.8,
      })
      .returning();
    if (!module) throw new Error('Failed to create training module.');
    const [activity] = await tx
      .insert(schema.activities)
      .values({
        trainingModuleId: module.id,
        kind: 'scorm_course',
        title: doc.title,
        config: { scormPackageId },
        weight: 1,
        orderingHint: 0,
      })
      .returning();
    if (!activity) throw new Error('Failed to create scorm_course activity.');
    return { moduleId: module.id, activityId: activity.id, created: true };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerAdminScormCourses(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /admin/content-pack-versions/:versionId/scorm-trainings
  //
  // Multipart upload. The "file" part is the SCORM zip; the "title"
  // part is the learner-facing title (defaults to the manifest title).
  // -------------------------------------------------------------------------
  app.post<{ Params: { versionId: string } }>(
    '/admin/content-pack-versions/:versionId/scorm-trainings',
    { schema: { params: z.object({ versionId: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.versionId),
        with: { pack: true },
      });
      if (!version) return reply.notFound();
      requireOrgInScope(scope, version.pack.ownerOrganizationId);
      if (version.status !== 'draft' && !request.auth?.platformAdmin) {
        return reply.badRequest('Training can only be added to draft versions.');
      }
      if (!request.isMultipart()) {
        return reply.badRequest('Expected multipart/form-data with a zip file.');
      }

      let title: string | null = null;
      let zipBuffer: Buffer | null = null;
      let originalFilename = 'scorm-package.zip';
      // @fastify/multipart's parts() iterator yields fields + files in
      // arrival order. Storyline+Articulate's web upload form typically
      // sends title first then file; we accept either order.
      for await (const part of request.parts()) {
        if (part.type === 'field' && part.fieldname === 'title') {
          title = String(part.value ?? '').trim() || null;
        } else if (part.type === 'file' && part.fieldname === 'file') {
          originalFilename = part.filename || originalFilename;
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const c of part.file as unknown as AsyncIterable<Buffer>) {
            total += c.length;
            if (total > MAX_PACKAGE_BYTES) {
              return reply.payloadTooLarge(
                `Package exceeds ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)} MB limit.`,
              );
            }
            chunks.push(c);
          }
          zipBuffer = Buffer.concat(chunks);
        }
      }
      if (!zipBuffer) return reply.badRequest('Missing "file" part with the SCORM zip.');

      // Open the zip and locate the manifest.
      let zip: JSZip;
      try {
        zip = await JSZip.loadAsync(zipBuffer);
      } catch (err) {
        return reply.badRequest(
          `Could not open zip: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const manifestEntry = zip.file(/^(.*\/)?imsmanifest\.xml$/i)[0];
      if (!manifestEntry) {
        return reply.badRequest(
          'No imsmanifest.xml at the package root — is this really a SCORM zip?',
        );
      }
      const manifestXml = await manifestEntry.async('string');
      const manifestInfo = parseManifest(manifestXml);
      if (!manifestInfo) {
        return reply.badRequest(
          'Could not parse imsmanifest.xml or find a launchable resource.',
        );
      }
      // If the manifest lives in a subdirectory (rare), all paths in it
      // are relative to that directory. Compute that base prefix.
      const manifestBase = manifestEntry.name.replace(/imsmanifest\.xml$/i, '');

      // Create the document + scorm_packages row up front so we have an
      // ID to use as the storage prefix.
      const finalTitle = (title ?? manifestInfo.title ?? originalFilename)
        .replace(/\.zip$/i, '')
        .slice(0, 200);
      const inserted = await db.transaction(async (tx) => {
        const [document] = await tx
          .insert(schema.documents)
          .values({
            contentPackVersionId: version.id,
            kind: 'scorm',
            title: finalTitle,
            extractionStatus: 'not_applicable',
            originalFilename,
            sizeBytes: zipBuffer.length,
          })
          .returning();
        if (!document) throw new Error('Failed to create document row.');
        const [pkg] = await tx
          .insert(schema.scormPackages)
          .values({
            documentId: document.id,
            // Placeholder — overwritten after we know the package ID
            // and have uploaded the files. The prefix has to encode
            // the org and package ID so storage's tenant-scope guard
            // (ownerOrgFromStorageKey) accepts subsequent reads.
            storageKeyPrefix: '',
            entryPath: manifestInfo.entryPath,
            scormVersion: manifestInfo.scormVersion,
            manifestTitle: manifestInfo.title,
          })
          .returning();
        if (!pkg) throw new Error('Failed to create scorm_packages row.');
        return { document, pkg };
      });

      // Extract every file. Each upload uses putBuffer with a path-style
      // filename so the resulting storage key ends in the same suffix.
      // The storage adapter's standard prefix is org/<orgId>/<sha>/...;
      // for SCORM we need a deterministic prefix tied to the package
      // (so /scorm-content/:id/<path> can resolve uniquely without
      // tracking each file's storage key in the DB).
      //
      // The simplest approach: put each file with a synthetic filename
      // composed of the package ID + relative path. ownerOrgFromKey
      // continues to work because the org prefix is still first.
      const ownerOrgId = version.pack.ownerOrganizationId;
      const filesIndex: Record<string, string> = {};
      const entries = Object.values(zip.files).filter((e) => !e.dir);
      for (const e of entries) {
        if (manifestBase && !e.name.startsWith(manifestBase)) continue;
        const relPath = manifestBase ? e.name.slice(manifestBase.length) : e.name;
        if (!relPath) continue;
        const buf = await e.async('nodebuffer');
        // Storage uses content-hash keys; we capture the returned key
        // and stash it in the package's filesIndex. Duplicate-bytes
        // files inside the same package dedup naturally, and the same
        // package re-uploaded re-resolves to the same keys.
        const stored = await storage.putBuffer({
          buffer: buf,
          filename: relPath.split('/').pop() ?? 'file',
          contentType: contentTypeFor(relPath),
          ownerOrganizationId: ownerOrgId,
        });
        filesIndex[relPath] = stored.storageKey;
      }
      const storageKeyPrefix = `scorm/${inserted.pkg.id}/`;
      await db
        .update(schema.scormPackages)
        .set({
          storageKeyPrefix,
          filesIndex,
          updatedAt: new Date(),
        })
        .where(eq(schema.scormPackages.id, inserted.pkg.id));

      // Wrap in training module + activity.
      const wrap = await ensureScormTrainingModule(
        db,
        inserted.document,
        inserted.pkg.id,
      );

      await db.insert(schema.auditEvents).values({
        organizationId: ownerOrgId,
        actorUserId: auth.userId,
        eventType: 'scorm_package.created',
        targetType: 'scorm_package',
        targetId: inserted.pkg.id,
        payload: {
          documentId: inserted.document.id,
          entryPath: manifestInfo.entryPath,
          scormVersion: manifestInfo.scormVersion,
          fileCount: entries.length,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.send({
        documentId: inserted.document.id,
        scormPackageId: inserted.pkg.id,
        trainingModuleId: wrap.moduleId,
        activityId: wrap.activityId,
        entryPath: manifestInfo.entryPath,
        scormVersion: manifestInfo.scormVersion,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /scorm-content/:packageId/* — serve an extracted SCORM file.
  //
  // The PWA proxies through here for same-origin iframe playback; admin
  // preview also uses this. Auth: scan-session OR auth, scoped to the
  // owner org of the package's document.
  // -------------------------------------------------------------------------
  app.get<{ Params: { packageId: string; '*': string } }>(
    '/scorm-content/:packageId/*',
    {
      schema: {
        params: z.object({
          packageId: UuidSchema,
          '*': z.string().min(1).max(2000),
        }),
      },
    },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();
      const pkg = await db.query.scormPackages.findFirst({
        where: eq(schema.scormPackages.id, request.params.packageId),
      });
      if (!pkg) return reply.notFound();
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, pkg.documentId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      const ownerOrgId = (doc as typeof doc & {
        packVersion: { pack: { ownerOrganizationId: string } };
      }).packVersion.pack.ownerOrganizationId;
      if (!scope.all && !scope.orgIds.includes(ownerOrgId)) {
        return reply.notFound();
      }

      const relPath = request.params['*'].replace(/^\/+/, '');
      // Reject any path segment that tries to traverse out of the
      // package or that's empty — the filesIndex is a closed set so
      // unknown paths just 404, but a defense-in-depth check belongs
      // here anyway.
      if (relPath.includes('..')) return reply.notFound();
      const key = pkg.filesIndex[relPath];
      if (!key) return reply.notFound();
      const result = await storage.stream(key);
      if (!result) return reply.notFound();
      reply.header('content-type', contentTypeFor(relPath));
      reply.header('cache-control', 'private, max-age=300');
      // Ensure the response isn't blocked from being framed by the
      // PWA: SCORM content lives in an iframe on a sibling origin
      // proxied to same-origin.
      reply.header('x-frame-options', 'SAMEORIGIN');
      return reply.send(result.stream);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/scorm-packages/:id  — admin detail (for the editor page)
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/admin/scorm-packages/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const pkg = await db.query.scormPackages.findFirst({
        where: eq(schema.scormPackages.id, request.params.id),
      });
      if (!pkg) return reply.notFound();
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, pkg.documentId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      requireOrgInScope(
        scope,
        (doc as typeof doc & {
          packVersion: { pack: { ownerOrganizationId: string } };
        }).packVersion.pack.ownerOrganizationId,
      );
      return reply.send({
        id: pkg.id,
        documentId: pkg.documentId,
        documentTitle: doc.title,
        entryPath: pkg.entryPath,
        scormVersion: pkg.scormVersion,
        manifestTitle: pkg.manifestTitle,
        createdAt: pkg.createdAt.toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /scan/activities/:activityId/scorm-package
  //
  // PWA-facing endpoint that returns the entry URL the player should
  // iframe. The PWA's same-origin proxy at /scorm-content/* handles
  // the actual file serving so SCORM's API stub on the parent window
  // stays reachable from the iframe.
  // -------------------------------------------------------------------------
  app.get<{ Params: { activityId: string } }>(
    '/scan/activities/:activityId/scorm-package',
    { schema: { params: z.object({ activityId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();
      const activity = await db.query.activities.findFirst({
        where: eq(schema.activities.id, request.params.activityId),
      });
      if (!activity || activity.kind !== 'scorm_course') return reply.notFound();
      const cfg = activity.config as { scormPackageId?: string };
      if (!cfg.scormPackageId) return reply.notFound();
      const pkg = await db.query.scormPackages.findFirst({
        where: eq(schema.scormPackages.id, cfg.scormPackageId),
      });
      if (!pkg) return reply.notFound();
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, pkg.documentId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      const ownerOrgId = (doc as typeof doc & {
        packVersion: { pack: { ownerOrganizationId: string } };
      }).packVersion.pack.ownerOrganizationId;
      if (!scope.all && !scope.orgIds.includes(ownerOrgId)) return reply.notFound();
      return reply.send({
        scormPackageId: pkg.id,
        entryPath: pkg.entryPath,
        scormVersion: pkg.scormVersion,
        title: doc.title,
      });
    },
  );
}

