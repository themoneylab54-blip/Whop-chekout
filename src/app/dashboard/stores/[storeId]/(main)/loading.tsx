import { SkeletonCard, SkeletonHeader, SkeletonPage } from "@/components/dashboard/Skeleton";

/** Generic page skeleton: header + two columns of cards (most settings-style pages). */
export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeader />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-6">
          <SkeletonCard lines={5} />
          <SkeletonCard lines={3} />
        </div>
        <div className="space-y-6">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={2} />
        </div>
      </div>
    </SkeletonPage>
  );
}
