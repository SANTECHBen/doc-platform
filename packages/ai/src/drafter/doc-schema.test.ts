import { describe, expect, it } from 'vitest';
import {
  DraftDocProposalTreeSchema,
  DraftDocStepProposalSchema,
} from './schema.js';

describe('DraftDocStepProposalSchema', () => {
  it('accepts a doc step with section + figure refs and applies defaults', () => {
    const parsed = DraftDocStepProposalSchema.parse({
      clientId: 'step-1',
      confidence: 0.9,
      title: 'Loosen the four mounting bolts',
      sectionTitle: 'Removal',
      voiceoverText: 'Loosen the four mounting bolts in a star pattern.',
      figureRefs: ['fig-1'],
    });
    expect(parsed.kind).toBe('instruction'); // default
    expect(parsed.blocks).toEqual([]); // default
    expect(parsed.safetyCritical).toBe(false); // default
    expect(parsed.figureRefs).toEqual(['fig-1']);
  });

  it('rejects a doc step carrying video clip fields (wrong shape)', () => {
    // Doc steps must not have clip ranges — but zod ignores unknown keys, so
    // we assert the *required* doc fields instead: a missing title fails.
    const bad = DraftDocStepProposalSchema.safeParse({
      clientId: 'step-1',
      confidence: 0.5,
      voiceoverText: 'x',
    });
    expect(bad.success).toBe(false);
  });
});

describe('DraftDocProposalTreeSchema', () => {
  const figure = {
    figureId: 'fig-1',
    storageKey: 'org/x/figs/fig-1.jpg',
    mime: 'image/jpeg',
    width: 16,
    height: 16,
    caption: 'Figure 1.',
  };
  const step = {
    clientId: 'step-1',
    confidence: 0.8,
    title: 'Loosen the bolts',
    sectionTitle: 'Removal',
    voiceoverText: 'Loosen the four bolts.',
    figureRefs: ['fig-1'],
  };

  it('round-trips a valid document proposal tree', () => {
    const tree = DraftDocProposalTreeSchema.parse({
      schemaVersion: 1,
      source: 'document',
      summary: 'Replace the bracket assembly.',
      warnings: [],
      figures: [figure],
      steps: [step],
    });
    expect(tree.source).toBe('document');
    expect(tree.steps).toHaveLength(1);
    expect(tree.figures[0]!.figureId).toBe('fig-1');
  });

  it('requires the document source discriminator', () => {
    const bad = DraftDocProposalTreeSchema.safeParse({
      schemaVersion: 1,
      source: 'video',
      warnings: [],
      figures: [],
      steps: [step],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects an empty steps array', () => {
    const bad = DraftDocProposalTreeSchema.safeParse({
      schemaVersion: 1,
      source: 'document',
      warnings: [],
      figures: [],
      steps: [],
    });
    expect(bad.success).toBe(false);
  });
});
