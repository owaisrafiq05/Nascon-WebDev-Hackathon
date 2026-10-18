/**
 * The one place provider HTTP calls are made (I5.5, I5.8).
 *
 * Every call has a timeout, so a hung provider cannot hold a request open, and
 * every failure becomes a `ProviderError` that says whether it was temporary
 * (network, timeout, 429, 5xx: worth retrying after a delay) or permanent
 * (anything else: shown to a person with the provider's reason).
 */
export class ProviderError extends Error {
  readonly transient: boolean;
  readonly status: number | null;
  readonly providerCode: string | null;

  constructor(
    message: string,
    init: { transient: boolean; status?: number | null; providerCode?: string | null },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.transient = init.transient;
    this.status = init.status ?? null;
    this.providerCode = init.providerCode ?? null;
  }
}

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface ProviderRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly form?: Record<string, string>;
  readonly json?: unknown;
  readonly timeoutMs?: number;
}

export type ErrorExtractor = (body: unknown) => {
  message?: string | undefined;
  code?: string | undefined;
};

export async function providerFetch(
  request: ProviderRequest,
  extractError: ErrorExtractor = () => ({}),
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json', ...request.headers };
  let body: string | undefined;
  if (request.form !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(request.form).toString();
  } else if (request.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(request.json);
  }

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 10_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new ProviderError(
      timedOut ? 'The provider did not answer in time.' : 'The provider could not be reached.',
      { transient: true },
    );
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const extracted = extractError(parsed);
    throw new ProviderError(
      extracted.message ?? `The provider answered ${String(response.status)}.`,
      {
        transient: isTransientStatus(response.status),
        status: response.status,
        providerCode: extracted.code ?? null,
      },
    );
  }

  return { status: response.status, body: parsed };
}

/**
 * Retries a call on transient failures only, with a growing delay (I5.5).
 * A permanent failure is rethrown at once: retrying a rejected request would
 * only repeat the rejection.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof ProviderError) || !error.transient || attempt === attempts)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }

  throw lastError;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A string or number from a provider body, as text. */
export function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}
