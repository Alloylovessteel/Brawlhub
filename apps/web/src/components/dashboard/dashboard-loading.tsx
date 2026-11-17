import { Skeleton } from '@/components/ui/skeleton';

export function DashboardLoading({ label = 'Loading live data' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <div>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      </div>
      <p className="sr-only">{label}…</p>
      <div className="dashboard-grid">
        {[0, 1, 2, 3].map((item) => (
          <Skeleton key={item} className="h-28 rounded-card" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-72 rounded-card lg:col-span-2" />
        <Skeleton className="h-72 rounded-card" />
      </div>
    </div>
  );
}
