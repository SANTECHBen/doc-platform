// Public surface of the document-sections module.

export * from './types.js';
export {
  revalidateSection,
  parsePageMarkers,
  wordBigramJaccard,
  type RevalidatableSection,
  type RevalidationOutcome,
  type RevalidateInput,
  type EmbedSimilarityFn,
} from './revalidate.js';
