// Convention parser unit tests. Pure function — no DB, no LLM.

import { describe, expect, it } from 'vitest';
import { parseConvention } from './convention.js';
import type { Manifest, ProposalNode } from './schema.js';

function manifest(entries: Array<{ path: string; size?: number; type?: string | null }>): Manifest {
  return {
    rootName: 'root',
    totalFiles: entries.length,
    totalBytes: entries.reduce((s, e) => s + (e.size ?? 0), 0),
    entries: entries.map((e) => ({
      relativePath: e.path,
      size: e.size ?? 0,
      contentType: e.type === undefined ? null : e.type,
      lastModified: null,
    })),
  };
}

function readTextFromMap(map: Record<string, string>) {
  return async (path: string) => map[path] ?? null;
}

const findNode = (nodes: ProposalNode[], kind: ProposalNode['kind'], match: (n: ProposalNode) => boolean) =>
  nodes.find((n) => n.kind === kind && match(n));

describe('parseConvention', () => {
  it('emits an OEM organization for the top-level directory', async () => {
    const m = manifest([
      { path: 'Acme/FT-MERGE-90/hero.jpg', type: 'image/jpeg' },
      { path: 'Acme/FT-MERGE-90/docs/operator-manual.pdf', type: 'application/pdf' },
    ]);
    const scaffold = await parseConvention(m, { readText: async () => null });
    const org = findNode(scaffold.nodes, 'organization', () => true);
    expect(org).toBeDefined();
    if (org && org.kind === 'organization') {
      expect(org.payload.type).toBe('oem');
      expect(org.payload.name).toBe('Acme');
      expect(org.payload.oemCode).toBe('ACME');
      expect(org.fromConvention).toBe(true);
      expect(org.confidence).toBe(1);
    }
  });

  it('extracts asset model + hero + base content pack from <OEM>/<Model>/', async () => {
    const m = manifest([
      { path: 'Acme/FT-MERGE-90/hero.jpg', type: 'image/jpeg' },
      { path: 'Acme/FT-MERGE-90/docs/operator-manual.pdf', type: 'application/pdf' },
    ]);
    const scaffold = await parseConvention(m, { readText: async () => null });
    const model = findNode(scaffold.nodes, 'asset_model', () => true);
    const pack = findNode(scaffold.nodes, 'content_pack', () => true);
    const version = findNode(scaffold.nodes, 'content_pack_version', () => true);
    const doc = findNode(scaffold.nodes, 'document', () => true);
    expect(model).toBeDefined();
    expect(pack).toBeDefined();
    expect(version).toBeDefined();
    expect(doc).toBeDefined();
    if (model?.kind === 'asset_model') {
      expect(model.payload.modelCode).toBe('FT-MERGE-90');
      expect(model.payload.heroSourcePath).toBe('Acme/FT-MERGE-90/hero.jpg');
    }
    if (pack?.kind === 'content_pack') {
      expect(pack.payload.layerType).toBe('base');
    }
    if (doc?.kind === 'document') {
      expect(doc.payload.kind).toBe('pdf');
      expect(doc.payload.sourcePath).toBe('Acme/FT-MERGE-90/docs/operator-manual.pdf');
    }
  });

  it('parses branding files and applies them to the OEM', async () => {
    const m = manifest([
      { path: 'Acme/branding/primary-color.txt', size: 7 },
      { path: 'Acme/branding/on-primary.txt', size: 7 },
      { path: 'Acme/branding/logo.png', type: 'image/png' },
      { path: 'Acme/FT-MERGE-90/hero.jpg', type: 'image/jpeg' },
    ]);
    const scaffold = await parseConvention(m, {
      readText: readTextFromMap({
        'Acme/branding/primary-color.txt': '#F77531',
        'Acme/branding/on-primary.txt': '#FFFFFF',
      }),
    });
    const org = findNode(scaffold.nodes, 'organization', () => true);
    if (org?.kind === 'organization') {
      expect(org.payload.brandPrimary).toBe('#F77531');
      expect(org.payload.brandOnPrimary).toBe('#FFFFFF');
      expect(org.payload.logoSourcePath).toBe('Acme/branding/logo.png');
    }
  });

  it('expands parts.csv into part + bom_entry nodes', async () => {
    const m = manifest([
      { path: 'Acme/FT-MERGE-90/hero.jpg', type: 'image/jpeg' },
      { path: 'Acme/FT-MERGE-90/parts/parts.csv', size: 80 },
    ]);
    const scaffold = await parseConvention(m, {
      readText: readTextFromMap({
        'Acme/FT-MERGE-90/parts/parts.csv':
          'part_number,display_name,quantity,position\nDM-4712,Drive Motor,1,M1\nBR-99,Bearing,4,B-front',
      }),
    });
    const parts = scaffold.nodes.filter((n) => n.kind === 'part');
    const boms = scaffold.nodes.filter((n) => n.kind === 'bom_entry');
    expect(parts.length).toBe(2);
    expect(boms.length).toBe(2);
    const motor = parts.find(
      (n) => n.kind === 'part' && n.payload.oemPartNumber === 'DM-4712',
    );
    expect(motor).toBeDefined();
  });

  it('expands per-part folders parts/<PartNumber>/', async () => {
    const m = manifest([
      { path: 'Acme/FT-MERGE-90/hero.jpg', type: 'image/jpeg' },
      { path: 'Acme/FT-MERGE-90/parts/DM-4712/spec.pdf', type: 'application/pdf' },
      { path: 'Acme/FT-MERGE-90/parts/DM-4712/photo.jpg', type: 'image/jpeg' },
    ]);
    const scaffold = await parseConvention(m, { readText: async () => null });
    const part = scaffold.nodes.find(
      (n) => n.kind === 'part' && n.payload.oemPartNumber === 'DM-4712',
    );
    expect(part).toBeDefined();
    if (part?.kind === 'part') {
      expect(part.payload.imageSourcePath).toBe('Acme/FT-MERGE-90/parts/DM-4712/photo.jpg');
    }
  });

  it('treats schematics/ files as schematic documents', async () => {
    const m = manifest([
      { path: 'Acme/FT-MERGE-90/hero.jpg', type: 'image/jpeg' },
      { path: 'Acme/FT-MERGE-90/schematics/electrical-v3.pdf', type: 'application/pdf' },
    ]);
    const scaffold = await parseConvention(m, { readText: async () => null });
    const doc = scaffold.nodes.find((n) => n.kind === 'document');
    expect(doc).toBeDefined();
    if (doc?.kind === 'document') {
      expect(doc.payload.kind).toBe('schematic');
    }
  });

  it('emits training_module + lesson + document for training files', async () => {
    const m = manifest([
      { path: 'Acme/FT-MERGE-90/hero.jpg', type: 'image/jpeg' },
      { path: 'Acme/FT-MERGE-90/training/operator-level-1.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    ]);
    const scaffold = await parseConvention(m, { readText: async () => null });
    const module = scaffold.nodes.find((n) => n.kind === 'training_module');
    const lesson = scaffold.nodes.find((n) => n.kind === 'lesson');
    const doc = scaffold.nodes.find(
      (n) => n.kind === 'document' && n.payload.tags.includes('training'),
    );
    expect(module).toBeDefined();
    expect(lesson).toBeDefined();
    expect(doc).toBeDefined();
  });

  it('expands top-level instances.csv into asset_instance + qr_code rows', async () => {
    const m = manifest([
      { path: 'Acme/FT-MERGE-90/hero.jpg', type: 'image/jpeg' },
      { path: 'Acme/sites.csv', size: 30 },
      { path: 'instances.csv', size: 80 },
    ]);
    const scaffold = await parseConvention(m, {
      readText: readTextFromMap({
        'Acme/sites.csv': 'name,city,country\nMemphis DC,Memphis,US',
        'instances.csv':
          'serial_number,model_code,site_name\nFT-001,FT-MERGE-90,Memphis DC\nFT-002,FT-MERGE-90,Memphis DC',
      }),
    });
    const instances = scaffold.nodes.filter((n) => n.kind === 'asset_instance');
    const qrs = scaffold.nodes.filter((n) => n.kind === 'qr_code');
    const sites = scaffold.nodes.filter((n) => n.kind === 'site');
    expect(sites.length).toBe(1);
    expect(instances.length).toBe(2);
    expect(qrs.length).toBe(2);
  });

  it('flags malformed CSV rows in unmatched without breaking', async () => {
    const m = manifest([
      { path: 'Acme/FT-MERGE-90/hero.jpg', type: 'image/jpeg' },
      { path: 'instances.csv', size: 30 },
    ]);
    const scaffold = await parseConvention(m, {
      readText: readTextFromMap({
        'instances.csv': 'serial_number,site_name\nFT-001,Memphis', // missing model_code col
      }),
    });
    expect(scaffold.unmatched.length).toBeGreaterThan(0);
    expect(scaffold.nodes.find((n) => n.kind === 'asset_instance')).toBeUndefined();
  });

  it('puts unrecognized files under loose_files for the LLM', async () => {
    const m = manifest([
      { path: 'Acme/FT-MERGE-90/hero.jpg', type: 'image/jpeg' },
      { path: 'Acme/FT-MERGE-90/random/notes.txt', type: 'text/plain' },
    ]);
    const scaffold = await parseConvention(m, { readText: async () => null });
    expect(scaffold.looseFiles.find((f) => f.relativePath.endsWith('notes.txt'))).toBeDefined();
  });
});
