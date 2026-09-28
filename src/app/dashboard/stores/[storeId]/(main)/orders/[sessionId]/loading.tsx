import { Bone, SkeletonCard, SkeletonPage } from "@/components/dashboard/Skeleton";

export default function OrderLoading() {
  return (
    <SkeletonPage label="Chargement de la commande…">
      <Bone className="mb-4 h-4 w-28" />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Bone className="h-7 w-44" />
        <Bone className="h-5 w-16 rounded-full" />
        <Bone className="h-4 w-32" />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <div className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]">
            <div className="mb-5 flex items-center gap-3">
              <Bone className="h-9 w-9 rounded-[28%]" />
              <Bone className="h-4 w-24" />
            </div>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 py-2.5">
                <Bone className="h-11 w-11 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Bone className="h-3.5 w-2/3" />
                  <Bone className="h-3 w-1/3" />
                </div>
                <Bone className="h-3.5 w-14" />
              </div>
            ))}
            <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex justify-between">
                  <Bone className="h-3 w-24" />
                  <Bone className="h-3 w-16" />
                </div>
              ))}
            </div>
          </div>
          <SkeletonCard lines={5} />
        </div>
        <div className="space-y-6">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={4} />
        </div>
      </div>
    </SkeletonPage>
  );
}
