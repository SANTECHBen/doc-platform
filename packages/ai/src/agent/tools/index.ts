// Tool factory — bundle every agent tool with the same context.
//
// Returns a ToolSet compatible with `streamText({ tools })`. Tool names
// are the keys of this object; the LLM references them by name.

import type { AgentToolContext } from './context.js';
import {
  searchOrganizationsTool,
  searchAssetModelsTool,
  searchPartsTool,
  searchContentPacksTool,
} from './search.js';
import { extractPdfTextTool, readSmallTextFileTool, parseCsvTool } from './extract.js';
import { classifyImageTool } from './vision.js';
import { emitProposalNodeTool, finalizeProposalTool } from './emit.js';

export type { AgentToolContext, AgentEvent, MuxDirectUploadResult } from './context.js';

export function buildAgentTools(ctx: AgentToolContext) {
  return {
    searchOrganizations: searchOrganizationsTool(ctx),
    searchAssetModels: searchAssetModelsTool(ctx),
    searchParts: searchPartsTool(ctx),
    searchContentPacks: searchContentPacksTool(ctx),
    extractPdfText: extractPdfTextTool(ctx),
    readSmallTextFile: readSmallTextFileTool(ctx),
    parseCsv: parseCsvTool(ctx),
    classifyImage: classifyImageTool(ctx),
    emitProposalNode: emitProposalNodeTool(ctx),
    finalizeProposal: finalizeProposalTool(ctx),
  } as const;
}

export type AgentTools = ReturnType<typeof buildAgentTools>;
