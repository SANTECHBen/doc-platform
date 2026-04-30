// Re-validation unit tests. The algorithm is pure given inputs; we mock the
// embed callback to avoid Voyage round-trips and keep tests deterministic.

import { describe, expect, it } from 'vitest';
import {
  revalidateSection,
  wordBigramJaccard,
  parsePageMarkers,
  type RevalidatableSection,
  type EmbedSimilarityFn,
} from './revalidate.js';

const SECTION_DEFAULTS: Omit<RevalidatableSection, 'kind'> = {
  id: 'sec-1',
  pageStart: null,
  pageEnd: null,
  textPageHint: null,
  anchorExcerpt: null,
  anchorContextBefore: null,
  anchorContextAfter: null,
  timeStartSeconds: null,
  timeEndSeconds: null,
};

function pageRangeSection(overrides: Partial<RevalidatableSection> = {}): RevalidatableSection {
  return { ...SECTION_DEFAULTS, kind: 'page_range', ...overrides };
}
function textRangeSection(overrides: Partial<RevalidatableSection> = {}): RevalidatableSection {
  return { ...SECTION_DEFAULTS, kind: 'text_range', ...overrides };
}
function timeRangeSection(overrides: Partial<RevalidatableSection> = {}): RevalidatableSection {
  return { ...SECTION_DEFAULTS, kind: 'time_range', ...overrides };
}

// ---------------------------------------------------------------------------
// page_range
// ---------------------------------------------------------------------------

describe('revalidateSection: page_range', () => {
  const oldText = `<!-- page:1 -->\n# Intro\nWelcome to the manual.\n<!-- page:2 -->\n# Setup\nUnpack the equipment carefully and inspect for damage.\n<!-- page:3 -->\n# Operation\nPress the green button to start.\n`;

  it('accepts when content is identical', async () => {
    const r = await revalidateSection({
      section: pageRangeSection({ pageStart: 2, pageEnd: 2 }),
      oldExtractedText: oldText,
      newExtractedText: oldText,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('accepted');
  });

  it('flags when page count drops below pageEnd', async () => {
    const newText = `<!-- page:1 -->\n# Intro\nWelcome to the manual.\n<!-- page:2 -->\n# Setup\nUnpack carefully.\n`;
    const r = await revalidateSection({
      section: pageRangeSection({ pageStart: 2, pageEnd: 3 }),
      oldExtractedText: oldText,
      newExtractedText: newText,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('flagged');
    if (r.status === 'flagged') expect(r.reason).toContain('page count shrank');
  });

  it('accepts when page count is preserved and bigram overlap stays high', async () => {
    // Same section content with one trivial word change.
    const newText = `<!-- page:1 -->\n# Intro\nWelcome to the manual.\n<!-- page:2 -->\n# Setup\nUnpack the equipment carefully and inspect for any damage.\n<!-- page:3 -->\n# Operation\nPress the green button to start.\n`;
    const r = await revalidateSection({
      section: pageRangeSection({ pageStart: 2, pageEnd: 2 }),
      oldExtractedText: oldText,
      newExtractedText: newText,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('accepted');
  });

  it('flags when section page content was rewritten substantially', async () => {
    const newText = `<!-- page:1 -->\n# Intro\nWelcome to the manual.\n<!-- page:2 -->\n# Reorganization\nThis section now describes regulatory compliance procedures only.\n<!-- page:3 -->\n# Operation\nPress the green button to start.\n`;
    const r = await revalidateSection({
      section: pageRangeSection({ pageStart: 2, pageEnd: 2 }),
      oldExtractedText: oldText,
      newExtractedText: newText,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('flagged');
    if (r.status === 'flagged') expect(r.reason).toContain('page content drifted');
  });

  it('flags when new doc has no page markers', async () => {
    const newText = `# All Pages Together\nNo markers here.`;
    const r = await revalidateSection({
      section: pageRangeSection({ pageStart: 1, pageEnd: 2 }),
      oldExtractedText: oldText,
      newExtractedText: newText,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('flagged');
    if (r.status === 'flagged') expect(r.reason).toContain('no page markers');
  });
});

// ---------------------------------------------------------------------------
// text_range
// ---------------------------------------------------------------------------

describe('revalidateSection: text_range', () => {
  const excerpt = 'Lockout the main disconnect before performing any maintenance';
  const before = 'and verify zero energy state. ';
  const after = '. Failure to do so may result in serious injury.';

  const oldDoc =
    `# Safety\n\nGeneral safety information about the equipment.\n\n` +
    before + excerpt + after +
    `\n\nFor more information, contact support.`;

  it('stage 1: exact match accepts silently', async () => {
    const newDoc = oldDoc; // identical
    const r = await revalidateSection({
      section: textRangeSection({
        anchorExcerpt: excerpt,
        anchorContextBefore: before,
        anchorContextAfter: after,
      }),
      oldExtractedText: oldDoc,
      newExtractedText: newDoc,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') expect(r.reason).toBeNull();
  });

  it('stage 1: exact match works even when surrounding doc grew', async () => {
    const newDoc =
      `# Front matter\n\nNew preface added here.\n\n` +
      `# Safety\n\nGeneral safety information about the equipment.\n\n` +
      before + excerpt + after +
      `\n\nFor more information, contact support.\n\n# New chapter\n\nMore content.`;
    const r = await revalidateSection({
      section: textRangeSection({
        anchorExcerpt: excerpt,
        anchorContextBefore: before,
        anchorContextAfter: after,
      }),
      oldExtractedText: oldDoc,
      newExtractedText: newDoc,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('accepted');
  });

  it('stage 1: ambiguous (multiple exact matches) flags without disambiguation', async () => {
    const newDoc =
      `# Page A\n\n` + before + excerpt + after + `\n\n` +
      `# Page B\n\n` + before + excerpt + after + `\n`;
    const r = await revalidateSection({
      section: textRangeSection({
        anchorExcerpt: excerpt,
        anchorContextBefore: before,
        anchorContextAfter: after,
      }),
      oldExtractedText: oldDoc,
      newExtractedText: newDoc,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('flagged');
    if (r.status === 'flagged') expect(r.reason).toContain('cannot disambiguate');
  });

  it('stage 1: ambiguous match disambiguated by text_page_hint', async () => {
    const newDoc =
      `<!-- page:1 -->\n# Page A\n\n` + before + excerpt + after + `\n` +
      `<!-- page:2 -->\n# Page B\n\n` + before + excerpt + after + `\n`;
    const r = await revalidateSection({
      section: textRangeSection({
        anchorExcerpt: excerpt,
        anchorContextBefore: before,
        anchorContextAfter: after,
        textPageHint: 2,
      }),
      oldExtractedText: oldDoc,
      newExtractedText: newDoc,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') expect(r.reason).toContain('text_page_hint');
  });

  it('stage 2: windowed normalized match handles whitespace/case shift', async () => {
    // The excerpt is reformatted with extra whitespace and slightly different case.
    const newDoc =
      `# Safety\n\nGeneral safety information about the equipment.\n\n` +
      `and verify zero energy state.   Lockout  the main disconnect  before performing any  maintenance.   Failure to do so may result in serious injury.`;
    const r = await revalidateSection({
      section: textRangeSection({
        anchorExcerpt: excerpt,
        anchorContextBefore: before,
        anchorContextAfter: after,
      }),
      oldExtractedText: oldDoc,
      newExtractedText: newDoc,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') expect(r.reason).toMatch(/normalized/i);
  });

  it('stage 3: embedding fallback accepts when score >= threshold', async () => {
    // The excerpt has been paraphrased — exact and windowed both fail; embedding is the only path.
    const newDoc =
      `# Safety\n\nThe operator must isolate the primary disconnect prior to commencing maintenance work. Failure to follow this protocol may result in injury.`;

    const embedSimilarity: EmbedSimilarityFn = async ({ candidates }) => ({
      bestIndex: 0,
      bestScore: 0.95, // above 0.92 threshold
    });

    const r = await revalidateSection({
      section: textRangeSection({
        anchorExcerpt: excerpt,
        anchorContextBefore: before,
        anchorContextAfter: after,
      }),
      oldExtractedText: oldDoc,
      newExtractedText: newDoc,
      newDurationSeconds: null,
      embedSimilarity,
      candidateChunks: [
        {
          chunkId: 'c1',
          text: 'The operator must isolate the primary disconnect prior to commencing maintenance work.',
        },
      ],
    });
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') {
      expect(r.reason).toContain('embedding similarity');
      expect(r.updates?.anchorExcerpt).toContain('isolate the primary disconnect');
    }
  });

  it('stage 3: low embedding score flags for manual review', async () => {
    const newDoc = `# Completely Different\n\nThis chapter discusses unrelated regulatory compliance topics.`;
    const embedSimilarity: EmbedSimilarityFn = async () => ({ bestIndex: 0, bestScore: 0.4 });

    const r = await revalidateSection({
      section: textRangeSection({
        anchorExcerpt: excerpt,
        anchorContextBefore: before,
        anchorContextAfter: after,
      }),
      oldExtractedText: oldDoc,
      newExtractedText: newDoc,
      newDurationSeconds: null,
      embedSimilarity,
      candidateChunks: [{ chunkId: 'c1', text: 'unrelated topic' }],
    });
    expect(r.status).toBe('flagged');
    if (r.status === 'flagged') expect(r.reason).toContain('manual review');
  });

  it('flags when no embedding fallback configured and stages 1+2 missed', async () => {
    const newDoc = `# Different\n\nNo similar text here.`;
    const r = await revalidateSection({
      section: textRangeSection({
        anchorExcerpt: excerpt,
        anchorContextBefore: before,
        anchorContextAfter: after,
      }),
      oldExtractedText: oldDoc,
      newExtractedText: newDoc,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('flagged');
    if (r.status === 'flagged') expect(r.reason).toContain('no embedding fallback');
  });
});

// ---------------------------------------------------------------------------
// time_range
// ---------------------------------------------------------------------------

describe('revalidateSection: time_range', () => {
  it('accepts when end <= new duration', async () => {
    const r = await revalidateSection({
      section: timeRangeSection({ timeStartSeconds: 30, timeEndSeconds: 90 }),
      oldExtractedText: null,
      newExtractedText: null,
      newDurationSeconds: 600,
    });
    expect(r.status).toBe('accepted');
  });

  it('flags when video shorter than section end', async () => {
    const r = await revalidateSection({
      section: timeRangeSection({ timeStartSeconds: 30, timeEndSeconds: 90 }),
      oldExtractedText: null,
      newExtractedText: null,
      newDurationSeconds: 60,
    });
    expect(r.status).toBe('flagged');
    if (r.status === 'flagged') expect(r.reason).toContain('video shortened');
  });

  it('accepts when duration unknown (null)', async () => {
    const r = await revalidateSection({
      section: timeRangeSection({ timeStartSeconds: 30, timeEndSeconds: 90 }),
      oldExtractedText: null,
      newExtractedText: null,
      newDurationSeconds: null,
    });
    expect(r.status).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// Helper coverage
// ---------------------------------------------------------------------------

describe('parsePageMarkers', () => {
  it('parses marker positions correctly', () => {
    const text = `<!-- page:1 -->\nA\n<!-- page:2 -->\nB\n<!-- page:3 -->\nC`;
    const pages = parsePageMarkers(text);
    expect(pages).toHaveLength(3);
    expect(pages[0]!.pageNumber).toBe(1);
    expect(pages[1]!.pageNumber).toBe(2);
    expect(pages[2]!.pageNumber).toBe(3);
    // Each page slice runs from its marker to the next.
    expect(pages[0]!.charEnd).toBe(pages[1]!.charStart);
    expect(pages[1]!.charEnd).toBe(pages[2]!.charStart);
  });

  it('returns empty when no markers', () => {
    expect(parsePageMarkers('no markers here')).toEqual([]);
  });
});

describe('wordBigramJaccard', () => {
  it('returns 1 for identical text', () => {
    expect(wordBigramJaccard('the quick brown fox', 'the quick brown fox')).toBe(1);
  });

  it('returns 0 for fully disjoint text', () => {
    expect(wordBigramJaccard('apple banana cherry', 'planet rocket galaxy')).toBe(0);
  });

  it('strips page markers before comparing', () => {
    const a = '<!-- page:1 -->\nthe quick brown fox';
    const b = 'the quick brown fox';
    expect(wordBigramJaccard(a, b)).toBe(1);
  });

  it('handles minor edits with high similarity', () => {
    const a = 'unpack the equipment carefully and inspect for damage';
    const b = 'unpack the equipment carefully and inspect for any damage';
    const sim = wordBigramJaccard(a, b);
    expect(sim).toBeGreaterThan(0.7);
  });
});
