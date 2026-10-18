import { describe, expect, it } from 'vitest';

import {
  AVAILABILITY_STATUSES,
  type AvailabilityStatus,
  isAbsent,
  isAvailabilityStatus,
  isAvailableEmployee,
} from './availability.js';

const limits = { maxOpenLeadsPerEmployee: 3 };

describe('isAvailableEmployee', () => {
  it('is true for an Available employee below the limit', () => {
    expect(isAvailableEmployee({ status: 'available', openLeadCount: 2 }, limits)).toBe(true);
  });

  it('is false once the employee reaches the limit (F3.3)', () => {
    expect(isAvailableEmployee({ status: 'available', openLeadCount: 3 }, limits)).toBe(false);
    expect(isAvailableEmployee({ status: 'available', openLeadCount: 4 }, limits)).toBe(false);
  });

  it('is false for every status other than Available, even with no open leads', () => {
    const notAvailable: AvailabilityStatus[] = ['busy', 'on_leave', 'offline'];

    for (const status of notAvailable) {
      expect(isAvailableEmployee({ status, openLeadCount: 0 }, limits)).toBe(false);
    }
  });

  it('is false when the limit is 0, so a misconfigured rule assigns to nobody', () => {
    expect(
      isAvailableEmployee(
        { status: 'available', openLeadCount: 0 },
        { maxOpenLeadsPerEmployee: 0 },
      ),
    ).toBe(false);
  });
});

describe('isAbsent', () => {
  it('treats On leave and Offline as absence (F3.6)', () => {
    expect(isAbsent('on_leave')).toBe(true);
    expect(isAbsent('offline')).toBe(true);
  });

  it('does not treat Busy as absence, so acknowledged leads are left alone', () => {
    expect(isAbsent('busy')).toBe(false);
    expect(isAbsent('available')).toBe(false);
  });
});

describe('isAvailabilityStatus', () => {
  it('accepts every declared status', () => {
    for (const status of AVAILABILITY_STATUSES) {
      expect(isAvailabilityStatus(status)).toBe(true);
    }
  });

  it('rejects anything else, including near-misses from the interface', () => {
    expect(isAvailabilityStatus('Available')).toBe(false);
    expect(isAvailabilityStatus('on leave')).toBe(false);
    expect(isAvailabilityStatus(undefined)).toBe(false);
    expect(isAvailabilityStatus(1)).toBe(false);
  });
});
