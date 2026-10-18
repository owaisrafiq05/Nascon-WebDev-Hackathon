import type { PageInfo } from '../lib/schemas.js';
import { Button } from './Button.js';

/** Previous / next with the position in words. */
export function Pager({
  pageInfo,
  onPage,
}: {
  pageInfo: PageInfo;
  onPage: (page: number) => void;
}) {
  if (pageInfo.totalPages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="secondary"
        disabled={pageInfo.page <= 1}
        onClick={() => {
          onPage(pageInfo.page - 1);
        }}
      >
        Previous
      </Button>
      <span className="text-sm text-slate-700 dark:text-slate-300">
        Page {pageInfo.page} of {pageInfo.totalPages} ({pageInfo.total} total)
      </span>
      <Button
        type="button"
        variant="secondary"
        disabled={pageInfo.page >= pageInfo.totalPages}
        onClick={() => {
          onPage(pageInfo.page + 1);
        }}
      >
        Next
      </Button>
    </nav>
  );
}
