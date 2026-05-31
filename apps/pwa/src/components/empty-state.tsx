// EmptyState + ErrorBanner are shared across both apps. The canonical
// implementations live in @platform/ui; this thin re-export keeps the
// long-standing `@/components/empty-state` import path working for
// existing PWA consumers without a churn rename.

export { EmptyState, type EmptyStateProps, type EmptyStateTone, type IllustrationProps } from '@platform/ui';
export { ErrorBanner, type ErrorBannerProps } from '@platform/ui';
