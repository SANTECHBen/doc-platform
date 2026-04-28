// Dedup tools — let the agent look up existing entities before proposing
// duplicates. The actual DB queries live in the route handler that builds
// the AgentToolContext; these are thin tool wrappers.

import { tool } from 'ai';
import { z } from 'zod';
import type { AgentToolContext } from './context.js';

export function searchOrganizationsTool(ctx: AgentToolContext) {
  return tool({
    description:
      'Search existing organizations by name, OEM code, or type. Use BEFORE proposing a new organization — if an existing one matches by name or oemCode, do not propose a duplicate. Returns up to 10 matches.',
    inputSchema: z.object({
      name: z.string().nullish().describe('Display name (case-insensitive substring match)'),
      oemCode: z.string().nullish().describe('OEM code (exact match)'),
      type: z
        .enum(['oem', 'dealer', 'integrator', 'end_customer'])
        .nullish()
        .describe('Filter by organization type'),
    }),
    execute: async (input) => {
      ctx.emitEvent({
        type: 'tool_call',
        data: { name: 'searchOrganizations', input },
      });
      const matches = await ctx.searchOrganizations({
        name: input.name ?? undefined,
        oemCode: input.oemCode ?? undefined,
        type: input.type ?? undefined,
      });
      ctx.emitEvent({
        type: 'tool_result',
        data: { name: 'searchOrganizations', count: matches.length },
      });
      return { matches: matches.slice(0, 10) };
    },
  });
}

export function searchAssetModelsTool(ctx: AgentToolContext) {
  return tool({
    description:
      'Search existing asset models. Use to dedup before proposing a new asset_model node. Match by ownerOrgId + modelCode (exact) or displayName (substring).',
    inputSchema: z.object({
      ownerOrgId: z.string().uuid().nullish(),
      modelCode: z.string().nullish(),
      displayName: z.string().nullish(),
    }),
    execute: async (input) => {
      ctx.emitEvent({
        type: 'tool_call',
        data: { name: 'searchAssetModels', input },
      });
      const matches = await ctx.searchAssetModels({
        ownerOrgId: input.ownerOrgId ?? undefined,
        modelCode: input.modelCode ?? undefined,
        displayName: input.displayName ?? undefined,
      });
      ctx.emitEvent({
        type: 'tool_result',
        data: { name: 'searchAssetModels', count: matches.length },
      });
      return { matches: matches.slice(0, 10) };
    },
  });
}

export function searchPartsTool(ctx: AgentToolContext) {
  return tool({
    description:
      'Search existing parts by OEM part number (exact) or name (substring). Use to dedup before proposing a new part node.',
    inputSchema: z.object({
      ownerOrgId: z.string().uuid().nullish(),
      partNumber: z.string().nullish(),
      name: z.string().nullish(),
    }),
    execute: async (input) => {
      ctx.emitEvent({
        type: 'tool_call',
        data: { name: 'searchParts', input },
      });
      const matches = await ctx.searchParts({
        ownerOrgId: input.ownerOrgId ?? undefined,
        partNumber: input.partNumber ?? undefined,
        name: input.name ?? undefined,
      });
      ctx.emitEvent({
        type: 'tool_result',
        data: { name: 'searchParts', count: matches.length },
      });
      return { matches: matches.slice(0, 20) };
    },
  });
}

export function searchContentPacksTool(ctx: AgentToolContext) {
  return tool({
    description:
      'Search existing content packs by asset model id and/or slug. Use to dedup before proposing a new content_pack node.',
    inputSchema: z.object({
      assetModelId: z.string().uuid().nullish(),
      slug: z.string().nullish(),
    }),
    execute: async (input) => {
      ctx.emitEvent({
        type: 'tool_call',
        data: { name: 'searchContentPacks', input },
      });
      const matches = await ctx.searchContentPacks({
        assetModelId: input.assetModelId ?? undefined,
        slug: input.slug ?? undefined,
      });
      ctx.emitEvent({
        type: 'tool_result',
        data: { name: 'searchContentPacks', count: matches.length },
      });
      return { matches };
    },
  });
}
