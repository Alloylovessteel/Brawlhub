import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export function Pagination({
  basePath,
  page,
  pageSize,
  count,
  params = {},
}: {
  basePath: string;
  page: number;
  pageSize: number;
  count: number;
  params?: Record<string, string | undefined>;
}) {
  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  const href = (target: number): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value.length > 0) search.set(key, value);
    }
    search.set('page', String(target));
    search.set('pageSize', String(pageSize));
    return `${basePath}?${search.toString()}`;
  };

  return (
    <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted">
      <span>
        Page {page} of {pageCount} · {count} record{count === 1 ? '' : 's'}
      </span>
      <div className="flex gap-2">
        {page <= 1 ? null : (
          <Link href={href(page - 1)} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            Previous
          </Link>
        )}
        {page >= pageCount ? null : (
          <Link href={href(page + 1)} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            Next
          </Link>
        )}
      </div>
    </div>
  );
}
