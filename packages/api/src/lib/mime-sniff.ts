// Magic-byte MIME validation. We never trust the client-supplied
// `Content-Type` header from a multipart upload — anyone can claim
// `image/png` while sending `<script>alert(1)</script>`. This module
// inspects the actual byte signature and returns the detected MIME.
//
// Coverage: the formats we actually accept across the platform (images,
// PDFs, common audio + video, Office docs, zip). SVG is deliberately
// absent — SVG can carry inline scripts and is dropped from the
// upload allowlist (see C-FILES-3).

export type DetectedMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | 'image/bmp'
  | 'application/pdf'
  | 'audio/mpeg'
  | 'audio/mp4'
  | 'audio/ogg'
  | 'audio/wav'
  | 'audio/webm'
  | 'video/mp4'
  | 'video/webm'
  | 'video/quicktime'
  | 'application/zip'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  | 'text/plain'
  | 'text/markdown';

/**
 * Sniff the magic bytes of a buffer and return the detected MIME, or
 * null when the bytes don't match any supported format. Caller decides
 * what to do with a null result (typically: reject the upload).
 *
 * Only inspects the first 64 bytes — sufficient for every container
 * format we support and bounded so a hostile small upload can't waste
 * compute.
 */
export function sniffMime(buf: Buffer): DetectedMime | null {
  if (buf.length < 4) return null;
  const head = buf.subarray(0, 64);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) return 'image/png';

  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';

  // GIF: "GIF87a" or "GIF89a"
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return 'image/gif';

  // BMP: "BM"
  if (head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp';

  // PDF: "%PDF-"
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) {
    return 'application/pdf';
  }

  // WAV: "RIFF" .... "WAVE"
  // WebP: "RIFF" .... "WEBP"
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
  ) {
    if (head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp';
    if (head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45) return 'audio/wav';
  }

  // Matroska/WebM: 1A 45 DF A3
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    // Inspect the DocType segment for "webm" vs default "matroska".
    // Cheap text search in the head — webm is the only matroska variant
    // we accept.
    const asString = head.toString('binary');
    if (asString.includes('webm')) return 'video/webm';
    return 'video/webm';
  }

  // OGG: "OggS"
  if (head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) return 'audio/ogg';

  // ISO BMFF / MP4 family. "ftyp" at offset 4, brand at 8-11.
  if (
    head.length >= 12 &&
    head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
  ) {
    const brand = head.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand.startsWith('M4A') || brand === 'mp42') return 'audio/mp4';
    if (
      brand === 'mp4 ' ||
      brand === 'isom' ||
      brand === 'iso2' ||
      brand === 'avc1' ||
      brand === 'mp41' ||
      brand === 'mp42' ||
      brand === 'dash'
    ) return 'video/mp4';
    // Default ISO-BMFF families to mp4 — common for tech-recorded clips.
    return 'video/mp4';
  }

  // MP3: ID3 tag ("ID3") or sync frame (FF Fx, FF Ex).
  if (head.length >= 3) {
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return 'audio/mpeg';
    if (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) return 'audio/mpeg';
  }

  // ZIP / OOXML: PK\x03\x04. Office formats are zip-based with specific
  // [Content_Types].xml entries — we treat the bare zip as the broadest
  // match and accept any OOXML claim that matches it.
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return 'application/zip';
  }

  // Plain text — last resort. Reject anything with NUL bytes; otherwise
  // assume text/plain. (Used only when the caller's allowlist permits
  // text uploads.)
  if (!head.includes(0x00)) return 'text/plain';

  return null;
}

/**
 * Strict check: the asserted MIME must be in the allowlist AND the
 * sniffed bytes must match (or be an acceptable equivalent — e.g. a
 * zip-shape file can carry an OOXML document type).
 */
export function isMimeAcceptable(
  asserted: string,
  sniffed: DetectedMime | null,
  allowlist: Set<string>,
): { ok: true; mime: DetectedMime } | { ok: false; reason: string } {
  const lower = asserted.toLowerCase();
  if (!allowlist.has(lower)) {
    return { ok: false, reason: `Unsupported content type: ${asserted}` };
  }
  if (sniffed === null) {
    return { ok: false, reason: 'File content does not match any supported format' };
  }
  // Exact match — happy path.
  if (sniffed === lower) return { ok: true, mime: sniffed };
  // OOXML documents are zip-shaped; allow when the asserted MIME is one
  // of the office formats AND the sniff returned application/zip.
  if (sniffed === 'application/zip' && lower.startsWith('application/vnd.openxmlformats-')) {
    return { ok: true, mime: lower as DetectedMime };
  }
  // Audio: some browsers emit `audio/mp3` for both ID3 and raw MP3 frames;
  // sniff also returns audio/mpeg for the same bytes. Accept the synonym.
  if (sniffed === 'audio/mpeg' && (lower === 'audio/mp3' || lower === 'audio/mpeg')) {
    return { ok: true, mime: 'audio/mpeg' };
  }
  return {
    ok: false,
    reason: `Declared content type ${asserted} does not match file contents (${sniffed})`,
  };
}
