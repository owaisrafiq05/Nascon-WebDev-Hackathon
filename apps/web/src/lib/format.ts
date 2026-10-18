/**
 * Small display helpers shared by the feature pages. Pure, so they are unit
 * tested without rendering anything.
 */

/** Formats integer minor units (cents) as money. */
export function formatMoney(minorUnits: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      minorUnits / 100,
    );
  } catch {
    // An unknown currency code must not break the page.
    return `${currency} ${(minorUnits / 100).toFixed(2)}`;
  }
}

/**
 * Converts what a person typed ("12.5", "1,200") to integer minor units.
 * Returns `null` for anything that is not a positive amount with at most two
 * decimals, so the form can say so instead of sending garbage.
 */
export function toMinorUnits(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const minor = Math.round(Number(cleaned) * 100);
  return minor > 0 ? minor : null;
}

/**
 * The text of an acknowledgement countdown (F3.4).
 *
 * `nowMs` is passed in so the caller owns the clock: one ticking hook feeds
 * every row, and tests can pin the time.
 */
export function formatCountdown(deadlineIso: string | null | undefined, nowMs: number): string {
  if (deadlineIso === null || deadlineIso === undefined) return 'No deadline';
  const deadline = Date.parse(deadlineIso);
  if (Number.isNaN(deadline)) return 'No deadline';

  const remaining = Math.ceil((deadline - nowMs) / 1000);
  if (remaining <= 0) return 'Overdue';

  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;

  if (hours > 0) return `${String(hours)}h ${String(minutes)}m left`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s left`;
  return `${String(seconds)}s left`;
}

/** "pending_ack" -> "Pending ack". Used only as a fallback for unknown codes. */
export function humanize(code: string): string {
  const spaced = code.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (iso === null || iso === undefined) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return date.toLocaleString(undefined, timeZone === undefined ? {} : { timeZone });
  } catch {
    return date.toLocaleString();
  }
}
