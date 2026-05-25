import type { FastifyInstance } from 'fastify';
import { requireAuthOrScan, getEffectiveOrgScope } from '../middleware/scan-session.js';

// Whitelist of safe MIME types we'll serve inline (Content-Type alone).
// Anything outside this set gets forced to `application/octet-stream` + an
// explicit `Content-Disposition: attachment` so the browser downloads it
// rather than rendering it inline. SVG is deliberately absent — it can
// carry inline scripts that would execute in the API origin.
const INLINE_SAFE_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
};

// Types we serve but force as attachment download. Office docs and archives
// are commonly used to deliver macro payloads or Mark-of-the-Web bypasses
// when served inline — push them through the file dialog instead.
const ATTACHMENT_TYPES: Record<string, string> = {
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.zip': 'application/zip',
};

export async function registerFileRoutes(app: FastifyInstance) {
  // Serve uploaded files by storage key. Auth + scope are MANDATORY — the
  // earlier "anonymous /files/* with a guessable UUID" pattern was a clean
  // bandwidth-amplification + cross-tenant read path (see C-FILES-1/3 in
  // the security audit).
  //
  // Key format: `org/<uuid>/<rest>`. We extract the owning org from the
  // key prefix and require the caller's scope (auth tree OR scan session)
  // to include it. Legacy keys without the prefix are refused — operators
  // running the migration backfill should reupload or grandfather them
  // explicitly here.
  app.get<{ Params: { '*': string } }>('/files/*', async (request, reply) => {
    const { storage, db } = app.ctx;
    const key = (request.params as { '*'?: string })['*'] ?? '';
    if (!key) return reply.notFound();
    // Path-traversal guard. Storage adapters defend against it too, but
    // belt-and-suspenders for any future adapter that doesn't.
    if (key.includes('..') || key.includes('\0') || key.startsWith('/')) {
      return reply.notFound();
    }

    // Authenticate.
    requireAuthOrScan(request);

    // Scope check.
    const ownerOrg = storage.ownerOrgFromKey(key);
    if (!ownerOrg) {
      // Legacy (pre-tenant-prefix) keys are rejected. Operators must
      // migrate or backfill the prefix; we'd rather refuse a request than
      // serve a tenant-unscoped object.
      app.log.warn({ key }, 'files: refusing legacy unscoped key');
      return reply.notFound();
    }
    const scope = await getEffectiveOrgScope(request, db);
    if (!scope) return reply.unauthorized();
    if (!scope.all && !scope.orgIds.includes(ownerOrg)) {
      // Return 404 (not 403) so the endpoint isn't an existence oracle.
      return reply.notFound();
    }

    const result = await storage.stream(key);
    if (!result) return reply.notFound();

    const ext = extname(key).toLowerCase();
    const inlineType = INLINE_SAFE_TYPES[ext];
    const attachmentType = ATTACHMENT_TYPES[ext];
    const contentType = inlineType ?? attachmentType ?? 'application/octet-stream';

    reply.header('content-type', contentType);
    // Tenant-scoped responses cannot be shared across users, so prevent
    // intermediaries from caching. The content itself is content-addressed
    // (immutable) but the URL-to-user binding is request-time.
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    if (!inlineType) {
      // Force-download for attachment types and unknowns.
      const filename = sanitizeDispositionFilename(key);
      reply.header(
        'content-disposition',
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
    }
    return reply.send(result.stream);
  });
}

function extname(p: string): string {
  const idx = p.lastIndexOf('.');
  return idx >= 0 ? p.slice(idx) : '';
}

function sanitizeDispositionFilename(key: string): string {
  // Take the last path segment and strip header-injection characters
  // (CR/LF, quote). The storage layer already restricts characters in
  // filenames; this is defense in depth.
  const base = key.split('/').pop() ?? 'download';
  return base.replace(/[\r\n"\\]/g, '_').slice(0, 200);
}
