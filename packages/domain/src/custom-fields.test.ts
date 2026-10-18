import { describe, expect, it } from 'vitest';

import {
  buildCustomFieldSchema,
  CUSTOM_FIELD_TYPES,
  type CustomFieldDefinition,
  isCustomFieldType,
  isRequiredInStage,
  isValidCustomFieldKey,
  missingFieldsMessage,
  missingRequiredFields,
} from './custom-fields.js';

function definition(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    key: 'roof_type',
    label: 'Roof type',
    type: 'text',
    options: [],
    required: false,
    requiredInStageIds: [],
    ...overrides,
  };
}

describe('custom field keys', () => {
  it('accepts a safe identifier', () => {
    expect(isValidCustomFieldKey('roof_type')).toBe(true);
    expect(isValidCustomFieldKey('survey2')).toBe(true);
  });

  it('refuses a key MongoDB would read as an operator or a path', () => {
    // `$` starts an operator and `.` is a path separator, so either would let a
    // field name reach into the query language.
    expect(isValidCustomFieldKey('$where')).toBe(false);
    expect(isValidCustomFieldKey('a.b')).toBe(false);
  });

  it('refuses anything else that is not a plain lowercase identifier', () => {
    expect(isValidCustomFieldKey('')).toBe(false);
    expect(isValidCustomFieldKey('Roof')).toBe(false);
    expect(isValidCustomFieldKey('2cold')).toBe(false);
    expect(isValidCustomFieldKey('roof type')).toBe(false);
  });
});

describe('isCustomFieldType', () => {
  it('accepts the five types F2.2 names', () => {
    expect([...CUSTOM_FIELD_TYPES]).toEqual(['text', 'number', 'date', 'dropdown', 'checkbox']);
    for (const type of CUSTOM_FIELD_TYPES) expect(isCustomFieldType(type)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isCustomFieldType('textarea')).toBe(false);
    expect(isCustomFieldType(undefined)).toBe(false);
  });
});

describe('buildCustomFieldSchema value types', () => {
  it('accepts a string for text and rejects a number', () => {
    const schema = buildCustomFieldSchema([definition({ required: true })]);

    expect(schema.safeParse({ roof_type: 'tile' }).success).toBe(true);
    expect(schema.safeParse({ roof_type: 7 }).success).toBe(false);
  });

  it('accepts a finite number and rejects a string or a non-finite value', () => {
    const schema = buildCustomFieldSchema([
      definition({ key: 'area', type: 'number', required: true }),
    ]);

    expect(schema.safeParse({ area: 42.5 }).success).toBe(true);
    expect(schema.safeParse({ area: 0 }).success).toBe(true);
    expect(schema.safeParse({ area: '42' }).success).toBe(false);
    expect(schema.safeParse({ area: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(schema.safeParse({ area: Number.NaN }).success).toBe(false);
  });

  it('accepts an ISO date and rejects other shapes', () => {
    const schema = buildCustomFieldSchema([
      definition({ key: 'survey_on', type: 'date', required: true }),
    ]);

    expect(schema.safeParse({ survey_on: '2026-03-14' }).success).toBe(true);
    expect(schema.safeParse({ survey_on: '14/03/2026' }).success).toBe(false);
    expect(schema.safeParse({ survey_on: '2026-03-14T10:00:00Z' }).success).toBe(false);
  });

  it('accepts only the dropdown options', () => {
    const schema = buildCustomFieldSchema([
      definition({ key: 'tier', type: 'dropdown', options: ['bronze', 'gold'], required: true }),
    ]);

    expect(schema.safeParse({ tier: 'gold' }).success).toBe(true);
    expect(schema.safeParse({ tier: 'platinum' }).success).toBe(false);
  });

  it('accepts nothing for a dropdown with no options, rather than any string', () => {
    const schema = buildCustomFieldSchema([
      definition({ key: 'tier', type: 'dropdown', options: [], required: true }),
    ]);

    expect(schema.safeParse({ tier: 'anything' }).success).toBe(false);
  });

  it('accepts a boolean for checkbox and rejects a truthy string', () => {
    const schema = buildCustomFieldSchema([
      definition({ key: 'surveyed', type: 'checkbox', required: true }),
    ]);

    expect(schema.safeParse({ surveyed: false }).success).toBe(true);
    expect(schema.safeParse({ surveyed: 'yes' }).success).toBe(false);
  });
});

describe('buildCustomFieldSchema optionality', () => {
  it('requires a field marked required', () => {
    const schema = buildCustomFieldSchema([definition({ required: true })]);

    expect(schema.safeParse({}).success).toBe(false);
  });

  it('allows an optional field to be absent or cleared', () => {
    const schema = buildCustomFieldSchema([definition()]);

    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ roof_type: null }).success).toBe(true);
  });

  it('requires a stage-required field only in that stage (F2.4)', () => {
    const definitions = [definition({ requiredInStageIds: ['stage-proposal'] })];

    expect(
      buildCustomFieldSchema(definitions, { stageId: 'stage-new' }).safeParse({}).success,
    ).toBe(true);
    expect(
      buildCustomFieldSchema(definitions, { stageId: 'stage-proposal' }).safeParse({}).success,
    ).toBe(false);
  });

  it('treats everything as optional in partial mode, for an edit of one field', () => {
    const schema = buildCustomFieldSchema([definition({ required: true })], { partial: true });

    expect(schema.safeParse({}).success).toBe(true);
  });

  it('strips an unknown key rather than failing', () => {
    // A field deleted while a form was open must not block the save with a
    // message about a field that no longer exists.
    const result = buildCustomFieldSchema([definition()]).safeParse({
      roof_type: 'tile',
      removed_field: 'x',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ roof_type: 'tile' });
  });

  it('is an empty object schema when there are no definitions', () => {
    expect(buildCustomFieldSchema([]).safeParse({}).success).toBe(true);
  });
});

describe('isRequiredInStage', () => {
  it('is true for an always-required field in any stage', () => {
    expect(isRequiredInStage(definition({ required: true }), null)).toBe(true);
    expect(isRequiredInStage(definition({ required: true }), 'stage-new')).toBe(true);
  });

  it('is true only in a listed stage for a stage-required field', () => {
    const field = definition({ requiredInStageIds: ['stage-proposal'] });

    expect(isRequiredInStage(field, 'stage-proposal')).toBe(true);
    expect(isRequiredInStage(field, 'stage-new')).toBe(false);
    expect(isRequiredInStage(field, null)).toBe(false);
  });

  it('is false for an unconditional optional field', () => {
    expect(isRequiredInStage(definition(), 'stage-proposal')).toBe(false);
  });
});

describe('missingRequiredFields', () => {
  const definitions = [
    definition({ key: 'roof_type', label: 'Roof type', requiredInStageIds: ['proposal'] }),
    definition({ key: 'area', label: 'Area', type: 'number', requiredInStageIds: ['proposal'] }),
  ];

  it('lists the fields with no value, by label', () => {
    const missing = missingRequiredFields(definitions, {}, 'proposal');

    expect(missing).toEqual([
      { key: 'roof_type', label: 'Roof type' },
      { key: 'area', label: 'Area' },
    ]);
  });

  it('is empty when every required field has a value', () => {
    expect(missingRequiredFields(definitions, { roof_type: 'tile', area: 50 }, 'proposal')).toEqual(
      [],
    );
  });

  it('counts null and an empty string as missing', () => {
    const missing = missingRequiredFields(definitions, { roof_type: '', area: null }, 'proposal');

    expect(missing).toHaveLength(2);
  });

  it('counts false and zero as present, not missing', () => {
    // Refusing these would make "required" impossible to satisfy with a
    // legitimate answer.
    const fields = [
      definition({ key: 'surveyed', type: 'checkbox', requiredInStageIds: ['proposal'] }),
      definition({ key: 'area', type: 'number', requiredInStageIds: ['proposal'] }),
    ];

    expect(missingRequiredFields(fields, { surveyed: false, area: 0 }, 'proposal')).toEqual([]);
  });

  it('ignores fields not required in the target stage', () => {
    expect(missingRequiredFields(definitions, {}, 'new')).toEqual([]);
  });
});

describe('missingFieldsMessage', () => {
  it('names one missing field and the stage', () => {
    const message = missingFieldsMessage('Proposal', [{ key: 'area', label: 'Area' }]);

    expect(message).toBe('Fill in Area before moving this to Proposal.');
  });

  it('joins several with commas and "and"', () => {
    const message = missingFieldsMessage('Proposal', [
      { key: 'a', label: 'Roof type' },
      { key: 'b', label: 'Area' },
      { key: 'c', label: 'Survey date' },
    ]);

    expect(message).toBe('Fill in Roof type, Area and Survey date before moving this to Proposal.');
  });
});
