import { maskSecret } from '@ubmp/shared';

import type { Providers } from '../integrations/registry.js';

/**
 * Logic behind `pnpm check:integrations`: argument parsing, missing-variable
 * detection, one verification per provider and result formatting. Kept apart
 * from the entry point so it can be tested with fake providers and no network.
 *
 * This reads a plain env record rather than `loadServerConfig`, because the
 * point of the check is to say *which* variable is missing or wrong, and the
 * config loader stops at the first malformed one.
 */
export type CheckStatus = 'OK' | 'FAIL' | 'SKIP';

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface CheckArgs {
  readonly sendTelegram: string | null;
  readonly twilioTo: string | null;
  readonly help: boolean;
  readonly errors: readonly string[];
}

export const USAGE = [
  'Usage: pnpm check:integrations [--send-telegram <chatId>] [--twilio-to <number>]',
  '',
  '  Reads the provider credentials from .env and makes one read-only call per',
  '  provider. Nothing is sent unless a flag below is given.',
  '',
  '  --send-telegram <chatId>  send one test message from the Telegram bot',
  '  --twilio-to <number>      send one test message from the Twilio sender',
  '                            (E.164, e.g. +923001234567; whatsapp: is added',
  '                            when the sender is a WhatsApp number)',
].join('\n');

export function parseArgs(argv: readonly string[]): CheckArgs {
  let sendTelegram: string | null = null;
  let twilioTo: string | null = null;
  let help = false;
  const errors: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--send-telegram' || arg === '--twilio-to') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--') || value.trim() === '') {
        errors.push(`${arg} needs a value`);
      } else {
        if (arg === '--send-telegram') sendTelegram = value.trim();
        else twilioTo = value.trim();
        index += 1;
      }
    } else {
      errors.push(`unknown argument ${arg}`);
    }
  }

  return { sendTelegram, twilioTo, help, errors };
}

export type Env = Readonly<Record<string, string | undefined>>;

/** An unset variable and an empty one (`KEY=`) both count as missing. */
export function readVar(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function missingVars(env: Env, names: readonly string[]): string[] {
  return names.filter((name) => readVar(env, name) === undefined);
}

/** Removes every known secret from text that is about to be printed. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length >= 6) {
      output = output.split(secret).join(maskSecret(secret));
    }
  }
  return output;
}

export function formatResult(result: CheckResult): string {
  return `${result.status} ${result.name}: ${result.detail}`;
}

export function hasFailure(results: readonly CheckResult[]): boolean {
  return results.some((result) => result.status === 'FAIL');
}

export function summarize(results: readonly CheckResult[]): string {
  const count = (status: CheckStatus) =>
    String(results.filter((result) => result.status === status).length);
  return `${count('OK')} ok, ${count('FAIL')} failed, ${count('SKIP')} skipped`;
}

const ok = (name: string, detail: string): CheckResult => ({ name, status: 'OK', detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: 'FAIL', detail });
const skip = (name: string, missing: readonly string[]): CheckResult => ({
  name,
  status: 'SKIP',
  detail: `missing ${missing.join(', ')}`,
});

export function checkEncryptionKey(env: Env): CheckResult {
  const value = readVar(env, 'ENCRYPTION_KEY');
  if (value === undefined) {
    return fail('encryption-key', 'ENCRYPTION_KEY is not set (openssl rand -base64 32)');
  }
  const bytes = Buffer.from(value, 'base64').length;
  return bytes === 32
    ? ok('encryption-key', 'ENCRYPTION_KEY decodes to 32 bytes')
    : fail(
        'encryption-key',
        `ENCRYPTION_KEY decodes to ${String(bytes)} bytes, expected 32 (openssl rand -base64 32)`,
      );
}

export function checkPublicBaseUrl(env: Env): CheckResult {
  const value = readVar(env, 'PUBLIC_BASE_URL');
  if (value === undefined) {
    return fail('public-base-url', 'PUBLIC_BASE_URL is not set (an https tunnel for webhooks)');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('public-base-url', 'PUBLIC_BASE_URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    return fail(
      'public-base-url',
      `PUBLIC_BASE_URL uses ${url.protocol.replace(':', '')}, providers need https for webhooks`,
    );
  }
  return ok('public-base-url', `webhooks will use ${url.origin}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** The WhatsApp sandbox needs `whatsapp:` on both ends; SMS needs neither. */
export function twilioRecipient(from: string, to: string): string {
  return from.startsWith('whatsapp:') && !to.startsWith('whatsapp:') ? `whatsapp:${to}` : to;
}

export async function checkTwilio(env: Env, args: CheckArgs, p: Providers): Promise<CheckResult> {
  const names = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM'];
  const missing = missingVars(env, names);
  if (missing.length > 0) return skip('twilio', missing);
  const credentials = {
    accountSid: readVar(env, 'TWILIO_ACCOUNT_SID') ?? '',
    authToken: readVar(env, 'TWILIO_AUTH_TOKEN') ?? '',
    from: readVar(env, 'TWILIO_WHATSAPP_FROM') ?? '',
  };
  try {
    const account = await p.messaging.verifyCredentials(credentials);
    let detail = `account "${account.accountName}" (sid ${maskSecret(credentials.accountSid)}, token ${maskSecret(credentials.authToken)})`;
    if (args.twilioTo !== null) {
      const sent = await p.messaging.send(credentials, {
        to: twilioRecipient(credentials.from, args.twilioTo),
        body: 'UBMP integration check: Twilio is wired up.',
        statusCallbackUrl: null,
      });
      detail += `; test message ${sent.providerMessageId} ${sent.status}`;
    }
    return ok('twilio', detail);
  } catch (error) {
    return fail('twilio', redact(errorMessage(error), Object.values(credentials)));
  }
}

export async function checkStripe(env: Env, p: Providers): Promise<CheckResult> {
  const missing = missingVars(env, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
  if (missing.length > 0) return skip('stripe', missing);
  const credentials = {
    secretKey: readVar(env, 'STRIPE_SECRET_KEY') ?? '',
    webhookSecret: readVar(env, 'STRIPE_WEBHOOK_SECRET') ?? '',
  };
  const live = 'live-mode key refused, use a test-mode key (sk_test_…)';
  // Refuse before any call, so a live key never reaches Stripe from this check.
  if (
    credentials.secretKey.startsWith('sk_live_') ||
    credentials.secretKey.startsWith('rk_live_')
  ) {
    return fail('stripe', live);
  }
  try {
    const result = await p.payments.verifyCredentials(credentials);
    if (result.livemode) return fail('stripe', live);
    const hint = credentials.webhookSecret.startsWith('whsec_')
      ? ''
      : '; STRIPE_WEBHOOK_SECRET does not start with whsec_';
    return ok('stripe', `test mode, key ${maskSecret(credentials.secretKey)}${hint}`);
  } catch (error) {
    return fail('stripe', redact(errorMessage(error), Object.values(credentials)));
  }
}

export async function checkTelegram(env: Env, args: CheckArgs, p: Providers): Promise<CheckResult> {
  const missing = missingVars(env, ['TELEGRAM_BOT_TOKEN']);
  if (missing.length > 0) return skip('telegram', missing);
  const token = readVar(env, 'TELEGRAM_BOT_TOKEN') ?? '';
  try {
    const bot = await p.notifications.verifyBot(token);
    let detail = `bot @${bot.username} (token ${maskSecret(token)})`;
    if (args.sendTelegram !== null) {
      const sent = await p.notifications.send(
        token,
        args.sendTelegram,
        'UBMP integration check: Telegram is wired up.',
      );
      detail += `; test message ${sent.messageId} sent`;
    }
    return ok('telegram', detail);
  } catch (error) {
    return fail('telegram', redact(errorMessage(error), [token]));
  }
}

/** Offline: only the OAuth client settings are checked, nothing is called. */
export function checkGoogle(env: Env, p: Providers): CheckResult {
  const names = [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REDIRECT_URI',
  ];
  const missing = missingVars(env, names);
  if (missing.length > 0) return skip('google', missing);
  const client = {
    clientId: readVar(env, 'GOOGLE_OAUTH_CLIENT_ID') ?? '',
    clientSecret: readVar(env, 'GOOGLE_OAUTH_CLIENT_SECRET') ?? '',
    redirectUri: readVar(env, 'GOOGLE_OAUTH_REDIRECT_URI') ?? '',
  };
  try {
    new URL(client.redirectUri);
  } catch {
    return fail('google', 'GOOGLE_OAUTH_REDIRECT_URI is not a valid URL');
  }
  // The real URL carries the client id; show only its last 4 characters.
  const url = new URL(p.calendar.authorizationUrl(client, 'STATE'));
  url.searchParams.set('client_id', maskSecret(client.clientId));
  const shape = decodeURIComponent(url.toString());
  return ok(
    'google',
    `client settings present (secret ${maskSecret(client.clientSecret)}), no network call; consent URL shape: ${shape}`,
  );
}

export async function runChecks(env: Env, args: CheckArgs, p: Providers): Promise<CheckResult[]> {
  const [twilio, stripe, telegram] = await Promise.all([
    checkTwilio(env, args, p),
    checkStripe(env, p),
    checkTelegram(env, args, p),
  ]);
  return [
    checkEncryptionKey(env),
    checkPublicBaseUrl(env),
    twilio,
    stripe,
    checkGoogle(env, p),
    telegram,
  ];
}
