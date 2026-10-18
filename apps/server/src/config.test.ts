import { EnvValidationError } from '@ubmp/shared';
import { describe, expect, it } from 'vitest';

import { loadServerConfig } from './config.js';

const minimal = { MONGODB_URI: 'mongodb://localhost:27017/ubmp' };

describe('loadServerConfig', () => {
  it('runs from the minimum a fresh clone provides', () => {
    const config = loadServerConfig(minimal);

    expect(config.env).toBe('development');
    expect(config.port).toBe(4000);
    expect(config.isProduction).toBe(false);
    expect(config.webOrigins).toEqual([]);
  });

  it('refuses to start without a database URI (Q6, Q13)', () => {
    expect(() => loadServerConfig({})).toThrow(EnvValidationError);
  });

  it('refuses a URI that is not a MongoDB URI', () => {
    expect(() => loadServerConfig({ MONGODB_URI: 'http://localhost:27017' })).toThrow(
      EnvValidationError,
    );
  });

  it('coerces PORT from its string form and rejects an out-of-range port', () => {
    expect(loadServerConfig({ ...minimal, PORT: '8080' }).port).toBe(8080);
    expect(() => loadServerConfig({ ...minimal, PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('parses the CORS allow-list into separate origins', () => {
    const config = loadServerConfig({
      ...minimal,
      WEB_ORIGINS: 'http://localhost:5173, https://app.example.com',
    });

    expect(config.webOrigins).toEqual(['http://localhost:5173', 'https://app.example.com']);
  });

  it('marks production so cookie and logging behaviour can branch on it', () => {
    expect(loadServerConfig({ ...minimal, NODE_ENV: 'production' }).isProduction).toBe(true);
  });

  it('rejects an unknown NODE_ENV instead of guessing', () => {
    expect(() => loadServerConfig({ ...minimal, NODE_ENV: 'staging' })).toThrow(EnvValidationError);
  });
});
