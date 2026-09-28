import { Bone, SkeletonHeader, SkeletonPage, SkeletonTable } from "@/components/dashboard/Skeleton";

export default function OrdersLoading() {
  return (
    <SkeletonPage label="Chargement des commandes…">
      <SkeletonHeader withActions />
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1.5">
          {[72, 84, 96, 56].map((w) => (
            <Bone key={w} className="h-9 rounded-lg" style={{ width: w }} />
          ))}
        </div>
        <Bone className="h-9 w-full rounded-lg sm:w-72" />
      </div>
      <div className="mb-4 flex justify-between gap-3">
        <Bone className="h-8 w-56 rounded-lg" />
        <Bone className="h-8 w-40 rounded-lg" />
      </div>
      <SkeletonTable rows={10} cols={5} />
    </SkeletonPage>
  );
}
