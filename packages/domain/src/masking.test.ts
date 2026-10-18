import { describe, expect, it } from 'vitest';

import {
  canViewOpportunityValue,
  MASKED_EXPORT_PLACEHOLDER,
  maskOpportunityValue,
  maskOpportunityValues,
  opportunityValueExportCell,
} from './masking.js';
import { effectivePermissions, PERMISSIONS } from './permissions.js';

const withValue = effectivePermissions({
  baseLevel: 'user',
  permissionSets: [{ permissions: [PERMISSIONS.CRM_VIEW, PERMISSIONS.OPPORTUNITY_VALUE_VIEW] }],
});

const withoutValue = effectivePermissions({
  baseLevel: 'user',
  permissionSets: [{ permissions: [PERMISSIONS.CRM_VIEW] }],
});

const ownerPermissions = effectivePermissions({ baseLevel: 'owner', permissionSets: [] });

const opportunity = { id: 'opp-1', name: 'Roof install', value: 250_000, currency: 'USD' };

describe('canViewOpportunityValue', () => {
  it('is true with the permission and false without it', () => {
    expect(canViewOpportunityValue(withValue)).toBe(true);
    expect(canViewOpportunityValue(withoutValue)).toBe(false);
  });

  it('is true for an Owner, who holds everything', () => {
    expect(canViewOpportunityValue(ownerPermissions)).toBe(true);
  });
});

describe('maskOpportunityValue', () => {
  it('passes the value through for a permitted reader', () => {
    expect(maskOpportunityValue(opportunity, withValue)).toEqual({
      ...opportunity,
      valueMasked: false,
    });
  });

  it('removes the value for a reader without the permission (F1.4)', () => {
    const masked = maskOpportunityValue(opportunity, withoutValue);

    expect(masked.value).toBeNull();
    expect(masked.valueMasked).toBe(true);
  });

  it('removes the currency with the value, so nothing can render "USD —"', () => {
    expect(maskOpportunityValue(opportunity, withoutValue).currency).toBeNull();
  });

  it('keeps every other field, so the record is still usable', () => {
    const masked = maskOpportunityValue(opportunity, withoutValue);

    expect(masked.id).toBe('opp-1');
    expect(masked.name).toBe('Roof install');
  });

  it('distinguishes "no value recorded" from "you may not see it"', () => {
    const empty = { id: 'opp-2', name: 'Survey', value: null, currency: null };

    // Nothing to hide: not reported as masked.
    expect(maskOpportunityValue(empty, withoutValue).valueMasked).toBe(false);
    // Something to hide: reported.
    expect(maskOpportunityValue(opportunity, withoutValue).valueMasked).toBe(true);
  });

  it('does not mutate the record it was given', () => {
    const snapshot = { ...opportunity };
    maskOpportunityValue(opportunity, withoutValue);

    expect(opportunity).toEqual(snapshot);
  });

  it('masks a zero value, which is a real recorded figure', () => {
    const free = { id: 'opp-3', name: 'Goodwill job', value: 0, currency: 'USD' };

    expect(maskOpportunityValue(free, withValue).value).toBe(0);
    expect(maskOpportunityValue(free, withoutValue).value).toBeNull();
  });
});

describe('maskOpportunityValues (the list path)', () => {
  it('masks every record for an unpermitted reader', () => {
    const masked = maskOpportunityValues(
      [opportunity, { ...opportunity, id: 'opp-9' }],
      withoutValue,
    );

    expect(masked.every((record) => record.value === null)).toBe(true);
    expect(masked).toHaveLength(2);
  });

  it('passes every record through for a permitted reader', () => {
    const visible = maskOpportunityValues([opportunity], withValue);

    expect(visible[0]?.value).toBe(250_000);
  });

  it('is empty for an empty list', () => {
    expect(maskOpportunityValues([], withoutValue)).toEqual([]);
  });
});

describe('opportunityValueExportCell (the export path)', () => {
  it('writes the amount for a permitted reader', () => {
    expect(opportunityValueExportCell(opportunity, withValue)).toBe('2500.00');
  });

  it('writes the placeholder, never the number, for an unpermitted reader', () => {
    const cell = opportunityValueExportCell(opportunity, withoutValue);

    expect(cell).toBe(MASKED_EXPORT_PLACEHOLDER);
    expect(cell).not.toContain('250');
  });

  it('writes an empty cell when no value was recorded', () => {
    expect(opportunityValueExportCell({ value: null, currency: null }, withValue)).toBe('');
  });

  it('applies the same rule as the list and detail paths (F1.4)', () => {
    // One rule, three call sites: all three hide for the same reader.
    expect(maskOpportunityValue(opportunity, withoutValue).value).toBeNull();
    expect(maskOpportunityValues([opportunity], withoutValue)[0]?.value).toBeNull();
    expect(opportunityValueExportCell(opportunity, withoutValue)).toBe(MASKED_EXPORT_PLACEHOLDER);
  });
});
