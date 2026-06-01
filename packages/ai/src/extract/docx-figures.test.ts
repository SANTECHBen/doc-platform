import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractDocxWithFigures } from './docx-figures.js';
import { buildSampleProcedureDocx } from './__fixtures__/sample-docx.js';

async function writeTempDocx(): Promise<string> {
  const buf = await buildSampleProcedureDocx();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docx-fig-test-'));
  const p = path.join(dir, 'sample.docx');
  await fs.writeFile(p, buf);
  return p;
}

describe('extractDocxWithFigures', () => {
  it('extracts embedded figures with positional tokens in reading order', async () => {
    const p = await writeTempDocx();
    const result = await extractDocxWithFigures(p);

    // Two embedded images → two figures, ids dense + in document order.
    expect(result.figures).toHaveLength(2);
    expect(result.figures.map((f) => f.figureId)).toEqual(['fig-1', 'fig-2']);
    expect(result.figures.every((f) => f.bytes.byteLength > 0)).toBe(true);
    // sharp re-encodes solid RGB images to JPEG.
    expect(result.figures[0]!.mime).toBe('image/jpeg');

    // Tokens land in the markdown, in the same order as the figures.
    const tokens = [...result.markdown.matchAll(/\[\[FIGURE:(fig-\d+)\]\]/g)].map((m) => m[1]);
    expect(tokens).toEqual(['fig-1', 'fig-2']);

    // Captions are picked up from the following "Figure N." paragraph.
    expect(result.figures[0]!.caption).toMatch(/^Figure 1\./);
    expect(result.figures[1]!.caption).toMatch(/^Figure 2\./);

    // Section headings survive as markdown headings.
    expect(result.markdown).toMatch(/^#\s+Removal/m);
    expect(result.markdown).toMatch(/^#\s+Replacement/m);

    // fig-1 sits in the Removal section, before the Replacement heading.
    const fig1Idx = result.markdown.indexOf('[[FIGURE:fig-1]]');
    const replIdx = result.markdown.indexOf('# Replacement');
    expect(fig1Idx).toBeGreaterThan(-1);
    expect(fig1Idx).toBeLessThan(replIdx);
  });
});
