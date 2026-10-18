import { vi } from 'vitest';

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

type Handler = unknown;

/**
 * Stubs `fetch` with a router: keys are `"METHOD /api/path"` matched as a
 * prefix of the request (path + query). Unmatched requests answer 404 so a
 * missing stub fails loudly. Returns the list of calls made.
 */
export function stubApi(routes: Record<string, Handler>): RecordedCall[] {
  const calls: RecordedCall[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const call: RecordedCall = { url: input, method, body };
      calls.push(call);

      const key = Object.keys(routes)
        .filter((candidate) => `${method} ${input}`.startsWith(candidate))
        .sort((a, b) => b.length - a.length)[0];

      if (key === undefined) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'NOT_FOUND', message: `no stub for ${method} ${input}` },
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      const handler = routes[key];
      const payload =
        typeof handler === 'function' ? (handler as (c: RecordedCall) => unknown)(call) : handler;
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );

  return calls;
}

export const identityFixture = (permissions: string[]) => ({
  user: { id: 'u1', email: 'me@example.com', name: 'Me' },
  workspace: { id: 'w1', name: 'Acme' },
  membership: { id: 'm1', baseLevel: 'admin', permissions },
});
