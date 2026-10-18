import { providers } from '../integrations/registry.js';

import {
  USAGE,
  formatResult,
  hasFailure,
  parseArgs,
  runChecks,
  summarize,
} from './check-integrations-lib.js';

/**
 * `pnpm check:integrations`: a live check of the provider credentials in `.env`
 * (run it once real sandbox credentials are in place). One read-only call per
 * provider; messages are sent only with `--send-telegram` / `--twilio-to`.
 * Secrets are never printed, at most their last 4 characters.
 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.errors.length > 0) {
    console.error(`${args.errors.join('\n')}\n\n${USAGE}`);
    return 2;
  }

  const results = await runChecks(process.env, args, providers());
  for (const result of results) process.stdout.write(`${formatResult(result)}\n`);
  process.stdout.write(`\n${summarize(results)}\n`);
  return hasFailure(results) ? 1 : 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'check failed');
    process.exit(1);
  });
