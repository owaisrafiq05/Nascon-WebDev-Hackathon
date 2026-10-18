import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiContractError, ApiError, apiRequest } from './api.js';

const schema = z.object({ ok: z.boolean() });

function mockFetch(
  init: { status?: number; body?: unknown; headers?: Record<string, string> } = {},
): void {
  const { status = 200, body = { ok: true }, headers = {} } = init;

  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json', ...headers },
        }),
      ),
    ),
  );
}

describe('apiRequest', () => {
  it('returns the parsed body on success', async () => {
    mockFetch({ body: { ok: true } });

    await expect(apiRequest('/api/thing', schema)).resolves.toEqual({ ok: true });
  });

  it('always sends cookies, so the session travels with the request', async () => {
    mockFetch();
    await apiRequest('/api/thing', schema);

    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(options?.credentials).toBe('include');
  });

  it('sets a JSON content type only when there is a body', async () => {
    mockFetch();
    await apiRequest('/api/thing', schema);
    const [, getOptions] = vi.mocked(fetch).mock.calls[0]!;
    expect((getOptions?.headers as Record<string, string>)['Content-Type']).toBeUndefined();

    mockFetch();
    await apiRequest('/api/thing', schema, { method: 'POST', body: { a: 1 } });
    const [, postOptions] = vi.mocked(fetch).mock.calls[0]!;
    expect((postOptions?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(postOptions?.body).toBe('{"a":1}');
  });

  it('turns the server error envelope into a typed ApiError (Q10)', async () => {
    mockFetch({
      status: 403,
      body: {
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to do that.',
          hint: 'Ask an administrator for the export permission.',
        },
        requestId: 'req-7',
      },
    });

    const error = await apiRequest('/api/thing', schema).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      message: 'You do not have permission to do that.',
      hint: 'Ask an administrator for the export permission.',
      requestId: 'req-7',
    });
  });

  it('exposes field errors so a form can mark the offending inputs', async () => {
    mockFetch({
      status: 422,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of the information you entered is not valid.',
          details: { fields: { email: 'is not a valid email address' } },
        },
      },
    });

    const error = (await apiRequest('/api/thing', schema).catch((e: unknown) => e)) as ApiError;

    expect(error.fields).toEqual({ email: 'is not a valid email address' });
  });

  it('reports a reachable server that answered with something unexpected', async () => {
    mockFetch({ status: 502, body: '<html>Bad Gateway</html>' });

    const error = (await apiRequest('/api/thing', schema).catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('The server returned an unexpected response.');
    expect(error.hint).toBeDefined();
  });

  it('reports an unreachable server with a message a user can act on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const error = (await apiRequest('/api/thing', schema).catch((e: unknown) => e)) as ApiError;

    expect(error.status).toBe(0);
    expect(error.message).toBe('The server could not be reached.');
    expect(error.hint).toContain('API is running');
  });

  it('fails loudly when a success body does not match the contract', async () => {
    mockFetch({ body: { ok: 'yes' } });

    await expect(apiRequest('/api/thing', schema)).rejects.toBeInstanceOf(ApiContractError);
  });
});
