// EmptyState's canonical implementation lives in @platform/ui. This
// thin re-export keeps the long-standing `@/components/empty-state`
// import path working for existing admin consumers without a churn
// rename.

export { EmptyState, type EmptyStateProps, type EmptyStateTone, type IllustrationProps } from '@platform/ui';
