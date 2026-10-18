import { useEffect } from 'react';
import { Link } from 'react-router-dom';

/** A polite live region for personal real-time events (P5). */
export function LiveNotice({
  notice,
  onDismiss,
}: {
  notice: string | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (notice === null) return undefined;
    const id = window.setTimeout(onDismiss, 10_000);
    return () => {
      window.clearTimeout(id);
    };
  }, [notice, onDismiss]);

  return (
    <div
      aria-live="polite"
      role="status"
      className="fixed right-3 bottom-3 left-3 z-50 sm:left-auto sm:max-w-sm"
    >
      {notice !== null && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 shadow-lg dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100">
          <span>{notice}</span>
          <span className="flex gap-3">
            <Link to="/leads" className="underline" onClick={onDismiss}>
              Open leads
            </Link>
            <button type="button" className="underline" onClick={onDismiss}>
              Dismiss
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
