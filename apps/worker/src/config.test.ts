import { EnvValidationError } from '@ubmp/shared';
import { describe, expect, it } from 'vitest';

import { loadWorkerConfig } from './config.js';

const minimal = { MONGODB_URI: 'mongodb://localhost:27017/ubmp' };

describe('loadWorkerConfig', () => {
  it('defaults the heartbeat interval to 10 seconds', () => {
    expect(loadWorkerConfig(minimal).heartbeatMs).toBe(10_000);
  });

  it('reads the configured interval', () => {
    expect(loadWorkerConfig({ ...minimal, WORKER_HEARTBEAT_MS: '2000' }).heartbeatMs).toBe(2_000);
  });

  it('refuses an interval so short it would hammer the database', () => {
    expect(() => loadWorkerConfig({ ...minimal, WORKER_HEARTBEAT_MS: '50' })).toThrow(
      EnvValidationError,
    );
  });

  it('refuses to start without a database URI', () => {
    expect(() => loadWorkerConfig({})).toThrow(EnvValidationError);
  });
});
