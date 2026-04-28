// Deterministic folder-convention parser.
//
// Runs before the LLM. Walks the manifest, recognizes the documented SANTECH
// onboarding layout, and emits a high-confidence ScaffoldTree. The LLM then
// only has to fill gaps and reason about loose files — it never has to
// re-derive what the convention can give us for free.
//
// Documented layout:
//   <OEM>/                              → organization (type=oem)
//     branding/
//       primary-color.txt               → brandPrimary
//       on-primary.txt                  → brandOnPrimary
//       logo.{png,svg,jpg}              → logoSourcePath
//     sites.csv                         → site rows (optional)
//     <Model>/                          → asset_model (modelCode = dir name)
//       hero.{jpg,png,webp}             → heroSourcePath
//       docs/*.{pdf,docx,md,pptx}       → document(s) under a content_pack
//       parts/<PartNumber>/             → part (folder name = oemPartNumber)
//         spec.{pdf,docx}               → part doc (linked into content pack)
//         photo.{jpg,png}               → imageSourcePath for the part
//       parts/parts.csv                 → bulk part list (optional)
//       training/*.{pptx,pdf,md,mp4}    → training module(s)
//       media/*.{mp4,mov}               → video documents
//       schematics/*.{pdf}              → schematic documents
//   instances.csv                       → asset_instance rows (optional)
//
// Anything that doesn't match → looseFiles[] for the LLM. Anything that DOES
// match the structure but has bad content (e.g. a CSV with missing columns)
// → unmatched[].

import { parse as parseCsvSync } from 'csv-parse/sync';
import {
  ScaffoldTreeSchema,
  type Manifest,
  type ManifestEntry,
  type ProposalNode,
  type ScaffoldTree,
} from './schema.js';

// Fast lookup of a manifest entry by relative path. Used by tools that fetch
// content during agent loop execution.
export type ManifestIndex = Map<string, ManifestEntry>;

export function buildManifestIndex(manifest: Manifest): ManifestIndex {
  const idx: ManifestIndex = new Map();
  for (const entry of manifest.entries) {
    idx.set(entry.relativePath, entry);
  }
  return idx;
}

// Browser-supplied file fetch — used for small text files (CSVs, color hex
// files) at convention-parse time. The agent never round-trips to the server
// for these; they're sent up-front as part of `parseManifestSamples`.
export interface ConventionContext {
  /** Read a small text file from the manifest by relative path. */
  readText: (relativePath: string) => Promise<string | null>;
}

interface PathParts {
  parts: string[];
  base: string;
  ext: string;
  baseLower: string;
  extLower: string;
}

function splitPath(relativePath: string): PathParts {
  const norm = relativePath.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  const parts = norm.split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? '';
  const dotAt = base.lastIndexOf('.');
  const ext = dotAt >= 0 ? base.slice(dotAt + 1) : '';
  return {
    parts,
    base,
    ext,
    baseLower: base.toLowerCase(),
    extLower: ext.toLowerCase(),
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function inferDocumentKind(extLower: string): ProposalNode['kind'] | null {
  // Maps to the document kind enum. Returns 'document' which we then
  // specialize via payload.kind.
  switch (extLower) {
    case 'pdf':
      return 'document';
    case 'docx':
    case 'doc':
      return 'document';
    case 'pptx':
    case 'ppt':
      return 'document';
    case 'md':
    case 'markdown':
      return 'document';
    case 'mp4':
    case 'mov':
    case 'webm':
    case 'm4v':
      return 'document';
    default:
      return null;
  }
}

function documentPayloadKindFor(extLower: string): {
  kind:
    | 'markdown'
    | 'pdf'
    | 'slides'
    | 'video'
    | 'schematic'
    | 'file';
} {
  switch (extLower) {
    case 'pdf':
      return { kind: 'pdf' };
    case 'pptx':
    case 'ppt':
      return { kind: 'slides' };
    case 'md':
    case 'markdown':
      return { kind: 'markdown' };
    case 'mp4':
    case 'mov':
    case 'webm':
    case 'm4v':
      return { kind: 'video' };
    default:
      return { kind: 'file' };
  }
}

// Title prettifier — strips extension, replaces separators, title-cases.
function prettyTitle(filename: string): string {
  const dotAt = filename.lastIndexOf('.');
  const stem = dotAt >= 0 ? filename.slice(0, dotAt) : filename;
  return stem
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isImageExt(ext: string): boolean {
  return ['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(ext);
}

function isVideoExt(ext: string): boolean {
  return ['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'].includes(ext);
}

function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s.trim());
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function parseConvention(
  manifest: Manifest,
  ctx: ConventionContext,
): Promise<ScaffoldTree> {
  const nodes: ProposalNode[] = [];
  const looseFiles: ScaffoldTree['looseFiles'] = [];
  const unmatched: ScaffoldTree['unmatched'] = [];

  // Bucket files by top-level directory.
  const filesByOem = new Map<string, ManifestEntry[]>();
  const topLevelLoose: ManifestEntry[] = [];

  for (const entry of manifest.entries) {
    const { parts } = splitPath(entry.relativePath);
    if (parts.length === 0) continue;
    if (parts.length === 1) {
      topLevelLoose.push(entry);
      continue;
    }
    const oemDir = parts[0]!;
    if (!filesByOem.has(oemDir)) filesByOem.set(oemDir, []);
    filesByOem.get(oemDir)!.push(entry);
  }

  // Top-level instances.csv — applies across all OEMs.
  const topLevelInstancesCsv = topLevelLoose.find(
    (e) => splitPath(e.relativePath).baseLower === 'instances.csv',
  );

  // Walk each OEM bucket.
  for (const [oemDir, entries] of filesByOem) {
    const oemSlug = slugify(oemDir);
    const oemClientId = `oem-${oemSlug}`;

    // Branding files / sites.csv / model dirs.
    const branding = {
      primaryHex: undefined as string | undefined,
      onPrimaryHex: undefined as string | undefined,
      logoPath: undefined as string | undefined,
    };
    // sites.csv at <OEM>/sites.csv (path parts: [<OEM>, sites.csv]).
    const sitesCsvPath: string | null =
      entries.find((e) => {
        const sp = splitPath(e.relativePath);
        return sp.parts.length === 2 && sp.baseLower === 'sites.csv';
      })?.relativePath ?? null;

    // Read branding text files (small, parsed eagerly via ctx.readText).
    for (const entry of entries) {
      const sp = splitPath(entry.relativePath);
      if (sp.parts.length >= 3 && sp.parts[1] === 'branding') {
        if (sp.baseLower === 'primary-color.txt') {
          const text = await ctx.readText(entry.relativePath);
          if (text && isHexColor(text)) branding.primaryHex = text.trim();
          else if (text)
            unmatched.push({
              relativePath: entry.relativePath,
              reason: `expected #RRGGBB hex; got "${text.slice(0, 30)}"`,
            });
        } else if (sp.baseLower === 'on-primary.txt') {
          const text = await ctx.readText(entry.relativePath);
          if (text && isHexColor(text)) branding.onPrimaryHex = text.trim();
        } else if (sp.baseLower.startsWith('logo.') && isImageExt(sp.extLower)) {
          branding.logoPath = entry.relativePath;
        }
      }
    }

    nodes.push({
      kind: 'organization',
      clientId: oemClientId,
      confidence: 1.0,
      sourceFiles: [{ relativePath: `${oemDir}/` }],
      rationale: `Top-level directory "${oemDir}" → OEM organization`,
      fromConvention: true,
      payload: {
        type: 'oem',
        name: oemDir,
        slug: oemSlug,
        oemCode: oemDir.toUpperCase().replace(/[^A-Z0-9]/g, ''),
        parentClientId: null,
        brandPrimary: branding.primaryHex ?? null,
        brandOnPrimary: branding.onPrimaryHex ?? null,
        logoSourcePath: branding.logoPath ?? null,
        displayNameOverride: null,
      },
    });

    // sites.csv — emit site rows under the OEM. (Sites typically belong to
    // end-customer orgs in real life, but for v1 we attach them to the OEM
    // org being onboarded — admin can re-parent in the review UI if needed.)
    if (sitesCsvPath) {
      const siteText = await ctx.readText(sitesCsvPath);
      if (siteText) {
        try {
          const rows = parseCsvSync(siteText, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
          }) as Record<string, string>[];
          for (const [i, row] of rows.entries()) {
            const name = row.name ?? row.site_name ?? row.siteName;
            if (!name) {
              unmatched.push({
                relativePath: sitesCsvPath,
                reason: `row ${i + 1}: missing required column "name" or "site_name"`,
              });
              continue;
            }
            const siteSlug = slugify(name);
            nodes.push({
              kind: 'site',
              clientId: `site-${oemSlug}-${siteSlug}`,
              confidence: 1.0,
              sourceFiles: [{ relativePath: sitesCsvPath }],
              rationale: `sites.csv row ${i + 1}`,
              fromConvention: true,
              payload: {
                organizationClientId: oemClientId,
                name,
                code: row.code ?? row.site_code ?? null,
                city: row.city ?? null,
                region: row.region ?? row.state ?? null,
                country: row.country ?? null,
                postalCode: row.postal_code ?? row.postalCode ?? row.zip ?? null,
                timezone: row.timezone ?? row.tz ?? null,
              },
            });
          }
        } catch (err) {
          unmatched.push({
            relativePath: sitesCsvPath,
            reason: `CSV parse error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    // Find model directories: <OEM>/<ModelDir>/...
    const modelDirs = new Set<string>();
    for (const entry of entries) {
      const sp = splitPath(entry.relativePath);
      if (sp.parts.length < 3) continue;
      const second = sp.parts[1]!;
      if (['branding'].includes(second)) continue;
      if (second.endsWith('.csv') || second.endsWith('.txt')) continue;
      modelDirs.add(second);
    }

    for (const modelDir of modelDirs) {
      const modelSlug = slugify(modelDir);
      const modelClientId = `model-${oemSlug}-${modelSlug}`;
      const modelEntries = entries.filter(
        (e) => splitPath(e.relativePath).parts[1] === modelDir,
      );

      // Hero image at <OEM>/<Model>/hero.{ext}
      const heroEntry = modelEntries.find((e) => {
        const sp = splitPath(e.relativePath);
        return (
          sp.parts.length === 3 &&
          sp.baseLower.startsWith('hero.') &&
          isImageExt(sp.extLower)
        );
      });

      nodes.push({
        kind: 'asset_model',
        clientId: modelClientId,
        confidence: 1.0,
        sourceFiles: [{ relativePath: `${oemDir}/${modelDir}/` }],
        rationale: `Directory "${oemDir}/${modelDir}" → asset model`,
        fromConvention: true,
        payload: {
          ownerOrganizationClientId: oemClientId,
          modelCode: modelDir,
          displayName: prettyTitle(modelDir),
          // Category isn't in the convention; default to "other" — the LLM
          // can refine in a follow-up emission.
          category: 'other',
          description: null,
          heroSourcePath: heroEntry?.relativePath ?? null,
        },
      });

      // Default content pack + draft version per model. The LLM can override.
      const packClientId = `pack-${oemSlug}-${modelSlug}-base`;
      const versionClientId = `pack-${oemSlug}-${modelSlug}-base-v1`;

      nodes.push({
        kind: 'content_pack',
        clientId: packClientId,
        confidence: 1.0,
        sourceFiles: [{ relativePath: `${oemDir}/${modelDir}/` }],
        rationale: 'Default base content pack per asset model',
        fromConvention: true,
        payload: {
          assetModelClientId: modelClientId,
          layerType: 'base',
          name: `${prettyTitle(modelDir)} — Base`,
          slug: `${oemSlug}-${modelSlug}-base`,
          basePackClientId: null,
        },
      });
      nodes.push({
        kind: 'content_pack_version',
        clientId: versionClientId,
        confidence: 1.0,
        sourceFiles: [{ relativePath: `${oemDir}/${modelDir}/` }],
        rationale: 'Initial draft version v1.0',
        fromConvention: true,
        payload: {
          contentPackClientId: packClientId,
          versionLabel: '1.0',
          changelog: 'Initial onboarding import',
        },
      });

      // docs/, schematics/, media/, training/ — each becomes documents (or
      // training modules) under the version.
      let docCounter = 0;
      const dropDocument = (entry: ManifestEntry, override?: { isSchematic?: boolean }) => {
        const sp = splitPath(entry.relativePath);
        if (!inferDocumentKind(sp.extLower)) return; // skip unknown ext
        docCounter += 1;
        const titleStem = prettyTitle(sp.base);
        const inferred = documentPayloadKindFor(sp.extLower);
        const finalKind = override?.isSchematic ? 'schematic' : inferred.kind;
        nodes.push({
          kind: 'document',
          clientId: `doc-${oemSlug}-${modelSlug}-${slugify(titleStem)}-${docCounter}`,
          confidence: 1.0,
          sourceFiles: [{ relativePath: entry.relativePath }],
          rationale: `File at ${entry.relativePath} → ${finalKind} document`,
          fromConvention: true,
          payload: {
            contentPackVersionClientId: versionClientId,
            kind: finalKind,
            title: titleStem,
            language: 'en',
            safetyCritical: false,
            tags: [],
            bodyMarkdown: null,
            sourcePath: entry.relativePath,
            externalUrl: null,
            streamPlaybackId: null,
            thumbnailSourcePath: null,
          },
        });
      };

      for (const entry of modelEntries) {
        const sp = splitPath(entry.relativePath);
        if (sp.parts.length < 4) {
          // Top of model dir: hero.* already captured; ignore the rest as
          // loose model-level files. The LLM can decide.
          if (sp.parts.length === 3 && entry !== heroEntry) {
            looseFiles.push({ relativePath: entry.relativePath });
          }
          continue;
        }
        const subdir = sp.parts[2]!;
        if (subdir === 'docs') {
          dropDocument(entry);
        } else if (subdir === 'schematics') {
          dropDocument(entry, { isSchematic: true });
        } else if (subdir === 'media' && isVideoExt(sp.extLower)) {
          dropDocument(entry);
        } else if (subdir === 'training') {
          // Training files become training_module nodes with a single lesson
          // referencing the file (uploaded as a document under the same
          // version). The LLM can refine titles/descriptions.
          docCounter += 1;
          const stem = prettyTitle(sp.base);
          const docClientId = `doc-${oemSlug}-${modelSlug}-training-${slugify(stem)}-${docCounter}`;
          const moduleClientId = `train-${oemSlug}-${modelSlug}-${slugify(stem)}-${docCounter}`;
          const lessonClientId = `lesson-${moduleClientId}`;

          const inferred = documentPayloadKindFor(sp.extLower);
          nodes.push({
            kind: 'document',
            clientId: docClientId,
            confidence: 1.0,
            sourceFiles: [{ relativePath: entry.relativePath }],
            rationale: 'Training source file',
            fromConvention: true,
            payload: {
              contentPackVersionClientId: versionClientId,
              kind: inferred.kind,
              title: stem,
              language: 'en',
              safetyCritical: false,
              tags: ['training'],
              bodyMarkdown: null,
              sourcePath: entry.relativePath,
              externalUrl: null,
              streamPlaybackId: null,
              thumbnailSourcePath: null,
            },
          });
          nodes.push({
            kind: 'training_module',
            clientId: moduleClientId,
            confidence: 1.0,
            sourceFiles: [{ relativePath: entry.relativePath }],
            rationale: 'Training file → training module',
            fromConvention: true,
            payload: {
              contentPackVersionClientId: versionClientId,
              title: stem,
              description: null,
              estimatedMinutes: null,
              competencyTag: null,
              passThreshold: null,
            },
          });
          nodes.push({
            kind: 'lesson',
            clientId: lessonClientId,
            confidence: 1.0,
            sourceFiles: [{ relativePath: entry.relativePath }],
            rationale: 'Lesson wrapping the training source document',
            fromConvention: true,
            payload: {
              trainingModuleClientId: moduleClientId,
              title: stem,
              bodyMarkdown: null,
              documentClientIds: [docClientId],
            },
          });
        } else if (subdir === 'parts') {
          // Either a parts.csv at parts/parts.csv or per-part folders with
          // spec.* / photo.*.
          if (sp.parts.length === 4 && sp.baseLower === 'parts.csv') {
            // bulk part list
            const text = await ctx.readText(entry.relativePath);
            if (text) {
              try {
                const rows = parseCsvSync(text, {
                  columns: true,
                  skip_empty_lines: true,
                  trim: true,
                }) as Record<string, string>[];
                for (const [i, row] of rows.entries()) {
                  const partNumber =
                    row.part_number ?? row.oem_part_number ?? row.partNumber;
                  const displayName =
                    row.display_name ?? row.name ?? row.description ?? partNumber;
                  if (!partNumber || !displayName) {
                    unmatched.push({
                      relativePath: entry.relativePath,
                      reason: `row ${i + 1}: missing part_number or display_name`,
                    });
                    continue;
                  }
                  const partClientId = `part-${oemSlug}-${slugify(partNumber)}`;
                  nodes.push({
                    kind: 'part',
                    clientId: partClientId,
                    confidence: 1.0,
                    sourceFiles: [{ relativePath: entry.relativePath }],
                    rationale: `parts.csv row ${i + 1}`,
                    fromConvention: true,
                    payload: {
                      ownerOrganizationClientId: oemClientId,
                      oemPartNumber: partNumber,
                      displayName,
                      description: row.description ?? null,
                      crossReferences: (row.cross_references ?? '')
                        .split(/[;,]/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                      imageSourcePath: null,
                    },
                  });
                  // Also add a BOM entry linking this part to the model.
                  nodes.push({
                    kind: 'bom_entry',
                    clientId: `bom-${modelSlug}-${slugify(partNumber)}`,
                    confidence: 1.0,
                    sourceFiles: [{ relativePath: entry.relativePath }],
                    rationale: 'BOM linkage from parts.csv',
                    fromConvention: true,
                    payload: {
                      assetModelClientId: modelClientId,
                      partClientId,
                      positionRef: row.position ?? row.position_ref ?? null,
                      quantity: Number.parseInt(row.quantity ?? '1', 10) || 1,
                      notes: row.notes ?? null,
                    },
                  });
                }
              } catch (err) {
                unmatched.push({
                  relativePath: entry.relativePath,
                  reason: `CSV parse error: ${err instanceof Error ? err.message : String(err)}`,
                });
              }
            }
          } else if (sp.parts.length >= 5) {
            // parts/<PartNumber>/{spec.*, photo.*}
            const partNumber = sp.parts[3]!;
            const partClientId = `part-${oemSlug}-${slugify(partNumber)}`;
            const haveAlready = nodes.some(
              (n) => n.kind === 'part' && n.clientId === partClientId,
            );
            if (!haveAlready) {
              nodes.push({
                kind: 'part',
                clientId: partClientId,
                confidence: 1.0,
                sourceFiles: [{ relativePath: `${sp.parts.slice(0, 4).join('/')}/` }],
                rationale: `Folder parts/${partNumber}`,
                fromConvention: true,
                payload: {
                  ownerOrganizationClientId: oemClientId,
                  oemPartNumber: partNumber,
                  displayName: prettyTitle(partNumber),
                  description: null,
                  crossReferences: [],
                  imageSourcePath: null,
                },
              });
              nodes.push({
                kind: 'bom_entry',
                clientId: `bom-${modelSlug}-${slugify(partNumber)}`,
                confidence: 1.0,
                sourceFiles: [{ relativePath: `${sp.parts.slice(0, 4).join('/')}/` }],
                rationale: 'BOM linkage from parts folder',
                fromConvention: true,
                payload: {
                  assetModelClientId: modelClientId,
                  partClientId,
                  positionRef: null,
                  quantity: 1,
                  notes: null,
                },
              });
            }
            // If this entry is photo.* update the part's image; if it's a
            // spec doc, attach it as a document under the version.
            if (sp.baseLower.startsWith('photo.') && isImageExt(sp.extLower)) {
              const partNode = nodes.find(
                (n) => n.kind === 'part' && n.clientId === partClientId,
              );
              if (partNode && partNode.kind === 'part') {
                partNode.payload.imageSourcePath = entry.relativePath;
              }
            } else if (inferDocumentKind(sp.extLower)) {
              dropDocument(entry);
            }
          }
        } else {
          // Unrecognized subdir under a model dir — treat as loose for the LLM.
          looseFiles.push({ relativePath: entry.relativePath });
        }
      }
    }

    // Per-OEM instances.csv (alternative location) at <OEM>/instances.csv.
    const oemInstancesEntry = entries.find(
      (e) =>
        splitPath(e.relativePath).parts.length === 2 &&
        splitPath(e.relativePath).baseLower === 'instances.csv',
    );
    if (oemInstancesEntry) {
      await emitInstancesFromCsv(
        nodes,
        unmatched,
        ctx,
        oemInstancesEntry.relativePath,
        oemSlug,
      );
    }
  }

  // Top-level instances.csv applies to whichever (oem, model) pair the rows
  // reference.
  if (topLevelInstancesCsv) {
    await emitInstancesFromCsv(
      nodes,
      unmatched,
      ctx,
      topLevelInstancesCsv.relativePath,
      null,
    );
  }

  // Top-level files that aren't instances.csv → loose.
  for (const entry of topLevelLoose) {
    if (entry === topLevelInstancesCsv) continue;
    looseFiles.push({ relativePath: entry.relativePath });
  }

  return ScaffoldTreeSchema.parse({
    schemaVersion: 1,
    nodes,
    looseFiles,
    unmatched,
  });
}

async function emitInstancesFromCsv(
  nodes: ProposalNode[],
  unmatched: { relativePath: string; reason: string }[],
  ctx: ConventionContext,
  csvPath: string,
  defaultOemSlug: string | null,
): Promise<void> {
  const text = await ctx.readText(csvPath);
  if (!text) return;
  let rows: Record<string, string>[];
  try {
    rows = parseCsvSync(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];
  } catch (err) {
    unmatched.push({
      relativePath: csvPath,
      reason: `CSV parse error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  for (const [i, row] of rows.entries()) {
    const serialNumber = row.serial_number ?? row.serialNumber ?? row.serial;
    const modelCode = row.model_code ?? row.modelCode ?? row.model;
    const siteName = row.site_name ?? row.siteName ?? row.site;
    if (!serialNumber || !modelCode || !siteName) {
      unmatched.push({
        relativePath: csvPath,
        reason: `row ${i + 1}: requires serial_number, model_code, site_name`,
      });
      continue;
    }
    // Find the matching model and site nodes by slug. If absent, skip — the
    // LLM can stitch them together.
    const oemSlug = defaultOemSlug ?? row.oem ?? row.oem_code;
    const modelSlug = slugify(modelCode);
    const siteSlug = slugify(siteName);
    const modelNode = nodes.find(
      (n) =>
        n.kind === 'asset_model' &&
        n.clientId.endsWith(`-${modelSlug}`) &&
        (oemSlug ? n.clientId.includes(`-${slugify(oemSlug)}-`) : true),
    );
    const siteNode = nodes.find(
      (n) =>
        n.kind === 'site' &&
        n.clientId.endsWith(`-${siteSlug}`) &&
        (oemSlug ? n.clientId.includes(`-${slugify(oemSlug)}-`) : true),
    );
    if (!modelNode || !siteNode) {
      unmatched.push({
        relativePath: csvPath,
        reason: `row ${i + 1}: couldn't resolve model "${modelCode}" or site "${siteName}" in scaffold`,
      });
      continue;
    }
    const instClientId = `instance-${slugify(serialNumber)}`;
    nodes.push({
      kind: 'asset_instance',
      clientId: instClientId,
      confidence: 1.0,
      sourceFiles: [{ relativePath: csvPath }],
      rationale: `instances.csv row ${i + 1}`,
      fromConvention: true,
      payload: {
        assetModelClientId: modelNode.clientId,
        siteClientId: siteNode.clientId,
        serialNumber,
        installedAt: row.installed_at ?? row.commissioned_at ?? null,
        pinnedContentPackVersionClientId: null,
      },
    });
    nodes.push({
      kind: 'qr_code',
      clientId: `qr-${slugify(serialNumber)}`,
      confidence: 1.0,
      sourceFiles: [{ relativePath: csvPath }],
      rationale: 'Auto-generated QR code per instance',
      fromConvention: true,
      payload: {
        assetInstanceClientId: instClientId,
        label: row.location ?? null,
        preferredTemplateId: null,
      },
    });
  }
}
