/**
 * Time-zone arithmetic without a library (I3).
 *
 * A date and time typed by a person means "wall-clock time in that zone". The
 * API wants UTC, so the zone's offset at that moment has to be applied, and the
 * offset itself depends on the moment (daylight saving), which is why this
 * iterates instead of using a fixed offset.
 */

const PART_FORMATS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = PART_FORMATS.get(timeZone);
  if (formatter === undefined) {
    // Throws RangeError for an unknown zone, which callers turn into a message.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PART_FORMATS.set(timeZone, formatter);
  }
  return formatter;
}

/** The zone's offset from UTC, in ms, at the given instant. */
function offsetMs(utcMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asIfUtc = Date.UTC(
    parts['year'] ?? 1970,
    (parts['month'] ?? 1) - 1,
    parts['day'] ?? 1,
    parts['hour'] ?? 0,
    parts['minute'] ?? 0,
    parts['second'] ?? 0,
  );
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Converts a wall-clock date (`YYYY-MM-DD`) and time (`HH:mm`) in `timeZone` to
 * the UTC instant. Throws `RangeError` for an unknown zone and for malformed
 * input.
 */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const time = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (date === null || time === null) throw new RangeError('Invalid date or time');

  const naive = Date.UTC(
    Number(date[1]),
    Number(date[2]) - 1,
    Number(date[3]),
    Number(time[1]),
    Number(time[2]),
  );

  // Two passes settle the offset when the guess lands on the other side of a
  // daylight-saving change.
  const first = naive - offsetMs(naive, timeZone);
  const second = naive - offsetMs(first, timeZone);
  return new Date(second);
}

/** `YYYY-MM-DD` one day after `dateStr` (calendar arithmetic, zone-free). */
export function nextDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
}

/** The UTC interval covering one calendar day in `timeZone`. */
export function dayRangeUtc(dateStr: string, timeZone: string): { from: Date; to: Date } {
  return {
    from: zonedTimeToUtc(dateStr, '00:00', timeZone),
    to: zonedTimeToUtc(nextDay(dateStr), '00:00', timeZone),
  };
}

/** The viewer's own zone, used as the default for a new booking. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Splits a UTC instant into the date and time fields as shown in `timeZone`. */
export function toZonedFields(iso: string, timeZone: string): { date: string; time: string } {
  const instant = new Date(iso).getTime();
  const wall = new Date(instant + offsetMs(instant, timeZone)).toISOString();
  return { date: wall.slice(0, 10), time: wall.slice(11, 16) };
}
