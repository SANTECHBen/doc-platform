'use client';

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-gradient-to-r from-surface-inset via-line-subtle to-surface-inset bg-[length:200%_100%] ${className}`}
      style={{ animation: 'skel 1.2s linear infinite' }}
    >
      <style jsx>{`
        @keyframes skel {
          0% {
            background-position: 200% 0;
          }
          100% {
            background-position: -200% 0;
          }
        }
      `}</style>
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
      <div className="border-b border-line bg-surface-inset px-4 py-2.5">
        <div className="flex gap-6">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-20" />
          ))}
        </div>
      </div>
      <div>
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="flex items-center gap-6 border-b border-line-subtle px-4 py-3.5"
            style={{ opacity: 1 - r * 0.12 }}
          >
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton
                key={c}
                className={`h-4 ${c === 0 ? 'w-32' : c === cols - 1 ? 'w-12' : 'w-24'}`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TilesSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-3 rounded-md border border-line-subtle bg-surface-raised p-5"
        >
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-2.5 w-24" />
        </div>
      ))}
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="h-9 w-96" />
      <Skeleton className="h-3 w-64" />
      <TableSkeleton rows={4} cols={5} />
    </div>
  );
}
