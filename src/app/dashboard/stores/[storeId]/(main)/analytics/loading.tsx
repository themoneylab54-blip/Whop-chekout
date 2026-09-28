import { SkeletonCard, SkeletonChart, SkeletonHeader, SkeletonPage, SkeletonTiles } from "@/components/dashboard/Skeleton";

export default function AnalyticsLoading() {
  return (
    <SkeletonPage label="Chargement des analytics…">
      <SkeletonHeader withActions />
      <SkeletonTiles count={6} />
      <SkeletonChart className="mb-6" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <SkeletonCard lines={5} />
        <SkeletonCard lines={4} />
        <SkeletonCard lines={4} />
        <SkeletonCard lines={3} />
      </div>
    </SkeletonPage>
  );
}
