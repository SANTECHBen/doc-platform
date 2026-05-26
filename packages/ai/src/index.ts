export * from './client';
export * from './retrieval';
export * from './troubleshooter';
export * from './guardrails';
export * from './prompts';
export * from './embeddings';
export * from './chunking';
export * from './pipeline';
export * from './search-retrieval';
export * from './search-indexer';
export * from './extract/index.js';
export {
  convertPptxToSlideImages,
  readSpeakerNotesFromPptx,
} from './extract/pptx-render.js';
export type { SlideRenderInput, SlideRenderResult } from './extract/pptx-render.js';
export * from './agent/index.js';
export * from './sections/index.js';
export * from './drafter/index.js';
