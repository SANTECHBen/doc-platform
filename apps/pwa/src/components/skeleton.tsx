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
