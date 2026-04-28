// Onboarding Agent — public surface.
//
// Importable as `@platform/ai/agent` once package exports are extended;
// for now consumers use `@platform/ai` and re-exports happen through
// `packages/ai/src/index.ts`.

export * from './schema.js';
export * from './convention.js';
export * from './prompts.js';
export * from './tools/index.js';
export * from './loop.js';
export * from './executor.js';
export * from './vision-impl.js';
