import { describe, expect, it } from 'vitest';

import { dayRangeUtc, nextDay, toZonedFields, zonedTimeToUtc } from './zoned-time.js';

describe('zonedTimeToUtc (I3)', () => {
  it('is the identity for UTC', () => {
    expect(zonedTimeToUtc('2026-03-10', '09:30', 'UTC').toISOString()).toBe(
      '2026-03-10T09:30:00.000Z',
    );
  });

  it('applies a fixed positive offset', () => {
    // Karachi is UTC+5 all year.
    expect(zonedTimeToUtc('2026-06-01', '10:00', 'Asia/Karachi').toISOString()).toBe(
      '2026-06-01T05:00:00.000Z',
    );
  });

  it('uses winter and summer offsets for the same zone', () => {
    expect(zonedTimeToUtc('2026-01-15', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-07-15', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-07-15T13:00:00.000Z',
    );
  });

  it('resolves a time just after a daylight-saving change', () => {
    // US clocks spring forward on 2026-03-08; 03:30 local is already EDT (UTC-4).
    expect(zonedTimeToUtc('2026-03-08', '03:30', 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('throws for an unknown zone or malformed input', () => {
    expect(() => zonedTimeToUtc('2026-01-01', '09:00', 'Not/AZone')).toThrow(RangeError);
    expect(() => zonedTimeToUtc('01/01/2026', '09:00', 'UTC')).toThrow(RangeError);
  });
});

describe('day helpers', () => {
  it('rolls over month ends', () => {
    expect(nextDay('2026-01-31')).toBe('2026-02-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
  });

  it('covers a 23-hour day across a daylight-saving change', () => {
    const { from, to } = dayRangeUtc('2026-03-08', 'America/New_York');
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(23);
  });

  it('splits an instant into the date and time shown in a zone', () => {
    expect(toZonedFields('2026-01-15T14:00:00.000Z', 'America/New_York')).toEqual({
      date: '2026-01-15',
      time: '09:00',
    });
  });
});
