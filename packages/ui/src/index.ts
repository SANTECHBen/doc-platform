// Public surface of @platform/ui — shared React primitives used by
// both apps/admin and apps/pwa.
//
// What lives here: components that have a clean, single API contract
// and surface the same on both apps. Domain-specific variants
// (TableSkeleton, DocListSkeleton, etc.) intentionally stay in the
// app that owns them.

export { EmptyState, type EmptyStateProps, type EmptyStateTone, type IllustrationProps } from './empty-state';
export { ErrorBanner, type ErrorBannerProps } from './error-banner';
export { Skeleton, type SkeletonProps } from './skeleton';
export { SegmentCard, type SegmentCardProps, type SegmentCardTone } from './segment-card';
