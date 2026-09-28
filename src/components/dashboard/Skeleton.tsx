/** Loading placeholders that mirror the dashboard's cards, tiles and tables. */

export function Bone({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={`block animate-pulse rounded-md bg-zinc-200/70 ${className}`} style={style} aria-hidden />;
}

/** Wraps a whole skeleton page: announces the loading state once to assistive tech. */
export function SkeletonPage({ label = "Chargement…", children }: { label?: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function SkeletonHeader({ withActions = false }: { withActions?: boolean }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-center gap-3.5">
        <Bone className="h-11 w-11 rounded-[28%]" />
        <div className="space-y-2">
          <Bone className="h-6 w-44" />
          <Bone className="h-3.5 w-64 max-w-[60vw]" />
        </div>
      </div>
      {withActions && <Bone className="h-9 w-56 rounded-xl" />}
    </div>
  );
}

export function SkeletonCard({ lines = 3, className = "", title = true }: { lines?: number; className?: string; title?: boolean }) {
  return (
    <div className={`rounded-2xl bg-white p-5 shadow-[var(--shadow-card)] ${className}`}>
      {title && (
        <div className="mb-5 flex items-center gap-3">
          <Bone className="h-9 w-9 rounded-[28%]" />
          <div className="space-y-1.5">
            <Bone className="h-4 w-36" />
            <Bone className="h-3 w-52 max-w-[50vw]" />
          </div>
        </div>
      )}
      <div className="space-y-3">
        {Array.from({ length: lines }, (_, i) => (
          <Bone key={i} className={`h-3.5 ${["w-full", "w-11/12", "w-4/5", "w-2/3", "w-3/4"][i % 5]}`} />
        ))}
      </div>
    </div>
  );
}

export function SkeletonTiles({ count = 4 }: { count?: number }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
          <Bone className="h-8 w-8 rounded-[28%]" />
          <Bone className="mt-3 h-3 w-20" />
          <Bone className="mt-2 h-6 w-24" />
          <Bone className="mt-2 h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonChart({ className = "" }: { className?: string }) {
  return (
    <div className={`rounded-2xl bg-white p-5 shadow-[var(--shadow-card)] ${className}`}>
      <div className="mb-5 flex items-center gap-3">
        <Bone className="h-9 w-9 rounded-[28%]" />
        <Bone className="h-4 w-44" />
      </div>
      <div className="flex gap-2">
        <div className="flex w-12 flex-col justify-between py-1">
          {[0, 1, 2, 3].map((i) => (
            <Bone key={i} className="h-2.5 w-9" />
          ))}
        </div>
        <div className="relative h-[200px] flex-1 overflow-hidden rounded-lg bg-gradient-to-b from-zinc-50 to-white">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="absolute inset-x-0 border-t border-dashed border-zinc-200" style={{ top: `${(i / 3) * 100}%` }} aria-hidden />
          ))}
          <span className="absolute inset-x-0 bottom-0 h-2/3 animate-pulse bg-gradient-to-t from-indigo-100/60 to-transparent [clip-path:polygon(0_70%,12%_55%,25%_62%,38%_40%,52%_48%,66%_25%,80%_35%,100%_10%,100%_100%,0_100%)]" aria-hidden />
        </div>
      </div>
    </div>
  );
}

/** Table on desktop, stacked rows on phones — same as the real Orders list. */
export function SkeletonTable({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
      <div className="hidden border-b border-zinc-100 px-4 py-3 md:flex md:gap-6">
        {Array.from({ length: cols }, (_, i) => (
          <Bone key={i} className="h-3 flex-1" />
        ))}
      </div>
      <ul className="divide-y divide-zinc-100">
        {Array.from({ length: rows }, (_, r) => (
          <li key={r} className="px-4 py-3.5">
            <div className="hidden items-center gap-6 md:flex">
              {Array.from({ length: cols }, (_, c) => (
                <Bone key={c} className={`h-3.5 flex-1 ${c === 1 ? "max-w-[240px]" : ""}`} />
              ))}
            </div>
            <div className="space-y-2 md:hidden">
              <div className="flex justify-between gap-4">
                <Bone className="h-3.5 w-40" />
                <Bone className="h-3.5 w-16" />
              </div>
              <div className="flex gap-2">
                <Bone className="h-3 w-24" />
                <Bone className="h-4 w-14 rounded-full" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
