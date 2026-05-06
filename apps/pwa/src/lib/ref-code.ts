import type { PwaDocumentSection } from './api';

const pad = (n: number, len: number) => String(n).padStart(len, '0');

const fmtTime = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function formatRefCode(
  idx: number,
  section?: PwaDocumentSection | null,
): string {
  if (!section) return `DOC-${pad(idx, 3)}`;
  const sec = `SEC-${pad(idx, 2)}`;
  if (section.pageStart != null) {
    const range =
      section.pageEnd != null && section.pageEnd !== section.pageStart
        ? `${section.pageStart}-${section.pageEnd}`
        : `${section.pageStart}`;
    return `${sec} · PG ${range}`;
  }
  if (section.timeStartSeconds != null) {
    const start = fmtTime(section.timeStartSeconds);
    if (
      section.timeEndSeconds != null &&
      section.timeEndSeconds !== section.timeStartSeconds
    ) {
      return `${sec} · ${start}-${fmtTime(section.timeEndSeconds)}`;
    }
    return `${sec} · ${start}`;
  }
  if (section.textPageHint != null) return `${sec} · PG ${section.textPageHint}`;
  return sec;
}
