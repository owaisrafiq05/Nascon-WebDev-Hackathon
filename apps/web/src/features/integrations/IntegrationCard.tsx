import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { Badge, MUTED, SURFACE } from '../../components/ui.js';
import { ApiError } from '../../lib/api.js';
import { formatDateTime, humanize } from '../../lib/format.js';
import {
  useDisconnectIntegration,
  useSaveIntegration,
  type Integration,
} from './integrations-api.js';

const STATUS: Record<string, { label: string; symbol: string; tone: 'neutral' | 'good' | 'bad' }> =
  {
    not_connected: { label: 'Not connected', symbol: '○', tone: 'neutral' },
    connected: { label: 'Connected', symbol: '✓', tone: 'good' },
    error: { label: 'Error', symbol: '!', tone: 'bad' },
  };

function absolute(url: string): string {
  return url.startsWith('/') ? `${window.location.origin}${url}` : url;
}

export function IntegrationCard({ integration }: { integration: Integration }) {
  const status = STATUS[integration.status] ?? {
    label: humanize(integration.status),
    symbol: '•',
    tone: 'neutral' as const,
  };
  const isGoogle = integration.provider === 'google';
  const id = `integration-${integration.provider}`;

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className={`${SURFACE} p-4 sm:p-5`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-heading`} className="text-sm font-semibold tracking-tight">
          {integration.name}
        </h2>
        <Badge tone={status.tone} symbol={status.symbol}>
          {status.label}
        </Badge>
      </div>

      <p className={`mt-1 ${MUTED}`}>
        Last success: {formatDateTime(integration.lastSuccessAt)}
        {integration.lastErrorAt != null &&
          ` · Last error: ${formatDateTime(integration.lastErrorAt)}`}
      </p>
      {integration.lastError != null && (
        <p className="mt-1 text-sm break-words text-red-800 dark:text-red-300">
          Last error: {integration.lastError}
        </p>
      )}

      {isGoogle && (
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-1">
            <dt>Configured on the server:</dt>
            <dd className="font-medium">{integration.configured === true ? 'Yes' : 'No'}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Connected employees:</dt>
            <dd className="font-medium">{integration.connectedEmployees ?? 0}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Need to reconnect:</dt>
            <dd className="font-medium">{integration.needsReconnect ?? 0}</dd>
          </div>
        </dl>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">What it can do</h3>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {integration.can.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-semibold">Limits</h3>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {integration.cannot.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>

      {integration.recentErrors.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">Recent errors</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {integration.recentErrors.map((entry, index) => (
              <li key={index} className="break-words">
                {formatDateTime(entry.at)} · {entry.kind ?? 'event'} · {entry.result ?? 'error'}:{' '}
                {entry.error ?? 'no detail'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isGoogle ? (
        <p className="mt-4 text-sm">
          Each employee connects their own calendar in{' '}
          <Link to="/settings" className="underline">
            Settings
          </Link>
          .
        </p>
      ) : (
        <WorkspaceProviderControls integration={integration} />
      )}
    </section>
  );
}

function WorkspaceProviderControls({ integration }: { integration: Integration }) {
  const provider = integration.provider;
  const save = useSaveIntegration(provider);
  const disconnect = useDisconnectIntegration(provider);
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const secrets = integration.fields?.secrets ?? [];
  const publics = integration.fields?.public ?? [];
  const fieldErrors = save.error instanceof ApiError ? (save.error.fields ?? {}) : {};
  const webhookEntries = Object.entries(integration.webhookUrls ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
  const connected = integration.status !== 'not_connected';

  return (
    <div className="mt-4 flex flex-col gap-4">
      {webhookEntries.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">Webhook URLs</h3>
          <p className={MUTED}>Paste these into the provider's dashboard.</p>
          <ul className="mt-1 flex flex-col gap-2">
            {webhookEntries.map(([name, url]) => (
              <li key={name} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{humanize(name)}:</span>
                <code className="min-w-0 break-all">{absolute(url)}</code>
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={`Copy ${humanize(name)} webhook URL`}
                  onClick={() => {
                    void navigator.clipboard.writeText(absolute(url)).then(() => {
                      setCopied(name);
                    });
                  }}
                >
                  {copied === name ? 'Copied' : 'Copy'}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const body: Record<string, string> = {};
          for (const key of secrets) body[key] = values[key] ?? '';
          for (const key of publics)
            body[key] = values[key] ?? integration.publicConfig?.[key] ?? '';
          save.mutate(body, {
            onSuccess: () => {
              setValues({});
            },
          });
        }}
      >
        <h3 className="text-sm font-semibold">{connected ? 'Update connection' : 'Connect'}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {publics.map((key) => (
            <Field
              key={key}
              label={humanize(key)}
              value={values[key] ?? integration.publicConfig?.[key] ?? ''}
              onChange={(event) => {
                setValues((current) => ({ ...current, [key]: event.target.value }));
              }}
              error={fieldErrors[key]}
            />
          ))}
          {secrets.map((key) => (
            <Field
              key={key}
              label={humanize(key)}
              type="password"
              autoComplete="off"
              placeholder="Leave blank to keep"
              value={values[key] ?? ''}
              onChange={(event) => {
                setValues((current) => ({ ...current, [key]: event.target.value }));
              }}
              hint={
                integration.secretHints?.[key] === undefined
                  ? 'Not set yet'
                  : `Stored: ${integration.secretHints[key]}`
              }
              error={fieldErrors[key]}
            />
          ))}
        </div>
        <div aria-live="polite" className="flex flex-col gap-2">
          <Alert error={save.error} />
          {save.isSuccess && <Notice>Saved. {integration.name} is connected.</Notice>}
        </div>
        <div>
          <Button type="submit" busy={save.isPending} busyLabel="Saving…">
            {connected ? 'Update' : 'Connect'}
          </Button>
        </div>
      </form>

      {connected && (
        <div>
          {!confirming ? (
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Disconnect
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">
                Disconnect {integration.name}? Messages and payments through it will stop.
              </span>
              <Button
                type="button"
                variant="danger"
                busy={disconnect.isPending}
                busyLabel="Disconnecting…"
                onClick={() => {
                  disconnect.mutate(undefined, {
                    onSuccess: () => {
                      setConfirming(false);
                    },
                  });
                }}
              >
                Yes, disconnect
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Keep it
              </Button>
            </div>
          )}
          <Alert error={disconnect.error} />
        </div>
      )}
    </div>
  );
}
