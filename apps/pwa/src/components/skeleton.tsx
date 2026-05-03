'use client';

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded bg-gradient-to-r from-surface-inset via-line-subtle to-surface-inset bg-[length:200%_100%] ${className}`}
      style={{ animation: 'skel 1.2s linear infinite' }}
    >
      <style jsx>{`
        @keyframes skel {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

export function DocListSkeleton() {
  return (
    <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="flex h-full w-full flex-col gap-3 rounded-md border border-line bg-surface-elevated p-4"
          style={{ opacity: 1 - i * 0.1 }}
        >
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-24" />
        </li>
      ))}
    </ul>
  );
}

// Matches the row-style cards used by section/training/component lists in
// the part overlay: bordered surface-raised row with a 18px icon area, a
// title line, and a meta line. Fades each row slightly so eye lands on
// the first.
export function RowListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {Array.from({ length: count }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-3 rounded-md border border-line bg-surface-raised px-4 py-3"
          style={{ opacity: 1 - i * 0.15 }}
        >
          <Skeleton className="h-[18px] w-[18px] shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </li>
      ))}
    </ul>
  );
}
