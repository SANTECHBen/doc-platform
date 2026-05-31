// SegmentCard's canonical implementation lives in @platform/ui (the
// admin also wants this primitive). This thin re-export keeps the
// long-standing `@/components/segment-card` import path working for
// existing PWA consumers.

export { SegmentCard, type SegmentCardProps, type SegmentCardTone } from '@platform/ui';
