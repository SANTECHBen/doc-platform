'use client';

export interface SkeletonProps {
  className?: string;
}

// Skeleton — the base shimmer rectangle used to indicate loading state
// before content lands. Sized by the caller via className.
//
// Animation: relies on a globally-defined `@keyframes skel` rule in the
// consuming app's globals.css. Defining the keyframes once globally
// (rather than per-mount via styled-jsx) means the React component is
// pure and the keyframe declaration doesn't ship in every consumer
// bundle.
export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      className={`rounded bg-gradient-to-r from-surface-inset via-line-subtle to-surface-inset bg-[length:200%_100%] ${className}`}
      style={{ animation: 'skel 1.2s linear infinite' }}
    />
  );
}
