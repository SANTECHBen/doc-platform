import type { FastifyInstance } from 'fastify';

const EXT_TO_TYPE: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

export async function registerFileRoutes(app: FastifyInstance) {
  // Serve uploaded files by storage key. Content-addressed keys mean this is
  // safe to cache aggressively (immutable once written).
  app.get<{ Params: { '*': string } }>('/files/*', async (request, reply) => {
    const { storage } = app.ctx;
    const key = (request.params as { '*'?: string })['*'] ?? '';
    if (!key) return reply.notFound();

    const result = await storage.stream(key);
    if (!result) return reply.notFound();

    const ext = extname(key).toLowerCase();
    const contentType = EXT_TO_TYPE[ext] ?? 'application/octet-stream';

    reply.header('content-type', contentType);
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(result.stream);
  });
}

function extname(p: string): string {
  const idx = p.lastIndexOf('.');
  return idx >= 0 ? p.slice(idx) : '';
}
