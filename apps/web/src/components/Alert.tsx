import { ApiError } from '../lib/api.js';

/**
 * A failure message with what to do about it (Q10).
 *
 * `role="alert"` so it is announced when it appears, and the server's hint is
 * shown under the message because "what went wrong" without "what you can do"
 * leaves the user stuck.
 */
export function Alert({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;

  const message = error instanceof Error ? error.message : 'Something went wrong.';
  const hint = error instanceof ApiError ? error.hint : undefined;

  return (
    <div
      role="alert"
      className="rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950"
    >
      <p className="text-sm font-medium text-red-900 dark:text-red-200">{message}</p>
      {hint !== undefined && <p className="mt-1 text-sm text-red-800 dark:text-red-300">{hint}</p>}
    </div>
  );
}

/** A confirmation, announced politely rather than interrupting. */
export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
    >
      {children}
    </div>
  );
}
