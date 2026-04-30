import { describe, expect, it } from 'vitest';
import { locateExcerptInPage, rectsForSpan, type RunPosition } from './excerpt-locator.js';

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
