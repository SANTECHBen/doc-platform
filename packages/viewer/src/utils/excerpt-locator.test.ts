import { describe, expect, it } from 'vitest';
import {
  locateExcerptInPage,
  rectsForSpan,
  findAllMatches,
  type RunPosition,
} from './excerpt-locator.js';

describe('locateExcerptInPage', () => {
  it('matches via full context+excerpt+context (stage 1)', () => {
    const r = locateExcerptInPage({
      pageText: 'Pre context. EXCERPT TEXT. Post context.',
      excerpt: 'EXCERPT TEXT',
      contextBefore: 'Pre context. ',
      contextAfter: '. Post context.',
    });
    expect(r).not.toBeNull();
    expect(r?.stage).toBe('context');
    expect(r?.charStart).toBe(13);
    expect(r?.charEnd).toBe(25);
  });

  it('falls through to exact excerpt match when context shifted (stage 2)', () => {
    const r = locateExcerptInPage({
      pageText: 'Different prefix here. EXCERPT TEXT. New suffix.',
      excerpt: 'EXCERPT TEXT',
      contextBefore: 'Pre context. ',
      contextAfter: '. Post context.',
    });
    expect(r).not.toBeNull();
    expect(r?.stage).toBe('excerpt');
    expect(r?.charStart).toBe(23);
  });

  it('falls through to normalized match on whitespace shift (stage 3)', () => {
    const r = locateExcerptInPage({
      pageText: 'Lockout  the   main\ndisconnect before any maintenance.',
      excerpt: 'Lockout the main disconnect',
      contextBefore: '',
      contextAfter: '',
    });
    expect(r).not.toBeNull();
    expect(r?.stage).toBe('normalized');
    // The match should start at the original "Lockout"
    expect(r?.charStart).toBe(0);
  });

  it('returns null when nothing matches', () => {
    const r = locateExcerptInPage({
      pageText: 'Completely different content here.',
      excerpt: 'Lockout the main disconnect',
      contextBefore: '',
      contextAfter: '',
    });
    expect(r).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(locateExcerptInPage({ pageText: '', excerpt: 'x' })).toBeNull();
    expect(locateExcerptInPage({ pageText: 'x', excerpt: '' })).toBeNull();
  });
});

describe('rectsForSpan', () => {
  const runs: RunPosition[] = [
    { charStart: 0, charEnd: 5, x: 0, y: 100, width: 50, height: 12 }, // "Hello"
    { charStart: 5, charEnd: 6, x: 50, y: 100, width: 5, height: 12 }, // " "
    { charStart: 6, charEnd: 11, x: 55, y: 100, width: 50, height: 12 }, // "world"
  ];

  it('produces a single rect when span lies inside one run', () => {
    const rects = rectsForSpan(1, 4, runs); // "ell"
    expect(rects).toHaveLength(1);
    expect(rects[0]!.x).toBeCloseTo(10);
    expect(rects[0]!.width).toBeCloseTo(30);
  });

  it('produces multiple rects when span crosses runs', () => {
    const rects = rectsForSpan(2, 9, runs); // "llo wo"
    expect(rects.length).toBeGreaterThanOrEqual(3);
    // First rect inside "Hello"
    expect(rects[0]!.x).toBeCloseTo(20);
    // Last rect inside "world"
    expect(rects[rects.length - 1]!.x).toBeCloseTo(55);
  });

  it('returns empty when span has no overlap with any run', () => {
    const rects = rectsForSpan(20, 30, runs);
    expect(rects).toEqual([]);
  });
});

describe('findAllMatches', () => {
  it('finds every case-insensitive occurrence in reading order', () => {
    const text = 'Belt belt BELT conveyor belt.';
    const m = findAllMatches(text, 'belt');
    expect(m).toHaveLength(4);
    expect(m[0]).toEqual({ charStart: 0, charEnd: 4 });
    expect(m[1]).toEqual({ charStart: 5, charEnd: 9 });
    expect(m[2]).toEqual({ charStart: 10, charEnd: 14 });
    // The slice round-trips back to the original text.
    expect(text.slice(m[3]!.charStart, m[3]!.charEnd).toLowerCase()).toBe('belt');
  });

  it('respects case-sensitive matching when requested', () => {
    const text = 'Belt belt BELT';
    const m = findAllMatches(text, 'belt', { caseSensitive: true });
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual({ charStart: 5, charEnd: 9 });
  });

  it('matches across collapsed whitespace and soft line breaks', () => {
    // PDF text layers fuse runs with spaces/newlines; the query has single
    // spaces but the text has a double space and a newline.
    const text = 'Inspect the debris  detection\ndevice before each shift.';
    const m = findAllMatches(text, 'debris detection device');
    expect(m).toHaveLength(1);
    // Maps back to the original "debris" start.
    expect(m[0]!.charStart).toBe(text.indexOf('debris'));
    // The matched original slice spans the line break.
    expect(text.slice(m[0]!.charStart, m[0]!.charEnd)).toContain('\n');
  });

  it('honors whole-word matching', () => {
    const text = 'cat category catalog scatter cat';
    const loose = findAllMatches(text, 'cat');
    // "cat", "cat"egory, "cat"alog, s"cat"ter, "cat" => 5 substring hits.
    expect(loose).toHaveLength(5);
    const whole = findAllMatches(text, 'cat', { wholeWord: true });
    expect(whole).toHaveLength(2);
    expect(whole[0]).toEqual({ charStart: 0, charEnd: 3 });
    expect(text.slice(whole[1]!.charStart, whole[1]!.charEnd)).toBe('cat');
  });

  it('produces non-overlapping matches for repeated patterns', () => {
    const m = findAllMatches('aaaa', 'aa');
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ charStart: 0, charEnd: 2 });
    expect(m[1]).toEqual({ charStart: 2, charEnd: 4 });
  });

  it('caps results at the supplied limit', () => {
    const m = findAllMatches('x x x x x x', 'x', { limit: 3 });
    expect(m).toHaveLength(3);
  });

  it('returns empty for empty or whitespace-only inputs', () => {
    expect(findAllMatches('', 'x')).toEqual([]);
    expect(findAllMatches('some text', '')).toEqual([]);
    expect(findAllMatches('some text', '   ')).toEqual([]);
  });

  it('returns empty when the query is absent', () => {
    expect(findAllMatches('hydraulic system pressure', 'pneumatic')).toEqual([]);
  });
});
