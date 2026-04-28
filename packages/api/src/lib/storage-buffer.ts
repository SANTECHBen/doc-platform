// Helper: read a storage object into a Buffer.
//
// The Storage interface only exposes `stream()` (efficient for large
// downloads). The agent's extraction tools want the whole file in memory
// (PDFs are typically a few MB; the chunking pipeline already does this).

import type { Storage } from '../storage.js';

export async function readStorageBuffer(
  storage: Storage,
  storageKey: string,
): Promise<Buffer | null> {
  const handle = await storage.stream(storageKey);
  if (!handle) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of handle.stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
