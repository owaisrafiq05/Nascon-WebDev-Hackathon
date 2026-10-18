import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  commaSeparatedList,
  EnvValidationError,
  loadEnv,
  maskSecret,
  mongoUriSchema,
} from './env.js';

const schema = z.object({
  MONGODB_URI: mongoUriSchema,
  WEB_ORIGINS: commaSeparatedList,
});

describe('loadEnv', () => {
  it('returns the parsed values from the given source', () => {
    const env = loadEnv('test', schema, {
      MONGODB_URI: 'mongodb://localhost:27017/ubmp',
      WEB_ORIGINS: 'http://localhost:5173',
    });

    expect(env.MONGODB_URI).toBe('mongodb://localhost:27017/ubmp');
    expect(env.WEB_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('names every offending variable in one error', () => {
    try {
      loadEnv('server', schema, { MONGODB_URI: 'postgres://nope' });
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('MONGODB_URI');
    }
  });

  it('never repeats the value of a variable in the error message', () => {
    const secretish = z.object({ SESSION_SECRET: z.string().min(32) });

    try {
      loadEnv('server', secretish, { SESSION_SECRET: 'too-short-but-still-a-secret' });
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('SESSION_SECRET');
      expect((error as Error).message).not.toContain('too-short-but-still-a-secret');
    }
  });

  it('points the reader at .env.example', () => {
    try {
      loadEnv('server', schema, {});
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('.env.example');
    }
  });
});

describe('commaSeparatedList', () => {
  it('trims entries and drops the empty ones a trailing comma leaves behind', () => {
    expect(commaSeparatedList.parse('a, b ,,c,')).toEqual(['a', 'b', 'c']);
  });

  it('is an empty list when unset, never a list containing an empty origin', () => {
    expect(commaSeparatedList.parse(undefined)).toEqual([]);
    expect(commaSeparatedList.parse('')).toEqual([]);
  });
});

describe('maskSecret', () => {
  it('shows only the last four characters', () => {
    expect(maskSecret('sk_test_51abcdefgHIJK')).toBe('********HIJK');
  });

  it('never returns any part of a very short secret', () => {
    expect(maskSecret('abcd')).toBe('****');
  });

  it('says so when the secret is not configured', () => {
    expect(maskSecret(undefined)).toBe('not set');
    expect(maskSecret('')).toBe('not set');
  });
});
