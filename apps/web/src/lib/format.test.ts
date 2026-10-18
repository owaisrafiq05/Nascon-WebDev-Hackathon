import { describe, expect, it } from 'vitest';

import { formatCountdown, formatMoney, toMinorUnits } from './format.js';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const at = (seconds: number): string => new Date(NOW + seconds * 1000).toISOString();

describe('formatCountdown (F3.4)', () => {
  it('shows minutes and seconds left', () => {
    expect(formatCountdown(at(80), NOW)).toBe('1m 20s left');
  });

  it('shows only seconds under a minute', () => {
    expect(formatCountdown(at(45), NOW)).toBe('45s left');
  });

  it('shows hours and minutes for long windows', () => {
    expect(formatCountdown(at(3600 + 120), NOW)).toBe('1h 2m left');
  });

  it('says Overdue at and after the deadline', () => {
    expect(formatCountdown(at(0), NOW)).toBe('Overdue');
    expect(formatCountdown(at(-30), NOW)).toBe('Overdue');
  });

  it('rounds a part-second up so it never shows 0s left', () => {
    expect(formatCountdown(new Date(NOW + 400).toISOString(), NOW)).toBe('1s left');
  });

  it('handles a missing deadline', () => {
    expect(formatCountdown(null, NOW)).toBe('No deadline');
    expect(formatCountdown(undefined, NOW)).toBe('No deadline');
  });
});

describe('money (I2)', () => {
  it('formats integer minor units with the currency', () => {
    expect(formatMoney(123456, 'USD')).toContain('1,234.56');
    expect(formatMoney(123456, 'USD')).toContain('$');
  });

  it('does not throw on an unknown currency code', () => {
    expect(formatMoney(500, 'XX')).toContain('5.00');
  });

  it('converts typed major units to integer minor units', () => {
    expect(toMinorUnits('150')).toBe(15000);
    expect(toMinorUnits('12.5')).toBe(1250);
    expect(toMinorUnits('1,200.99')).toBe(120099);
    expect(toMinorUnits('0.29')).toBe(29);
  });

  it('rejects zero, negatives, junk and extra decimals', () => {
    expect(toMinorUnits('0')).toBeNull();
    expect(toMinorUnits('-5')).toBeNull();
    expect(toMinorUnits('abc')).toBeNull();
    expect(toMinorUnits('1.234')).toBeNull();
    expect(toMinorUnits('')).toBeNull();
  });
});
