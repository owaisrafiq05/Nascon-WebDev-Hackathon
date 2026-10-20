import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { Badge, Card, Loading, PageContainer, PageTitle } from '../../components/ui.js';
import {
  useCalendarConnection,
  useConnectCalendar,
  useDisconnectCalendar,
  useNotificationSettings,
  useSaveNotificationSettings,
  useSendTestAlert,
} from './settings-api.js';

export function SettingsPage() {
  return (
    <PageContainer>
      <PageTitle kicker="Workspace" sub="Your own calendar and alert settings.">
        Settings
      </PageTitle>
      <CalendarSection />
      <NotificationsSection />
    </PageContainer>
  );
}

function CalendarSection() {
  const [params] = useSearchParams();
  const connection = useCalendarConnection();
  const connect = useConnectCalendar();
  const disconnect = useDisconnectCalendar();
  const [confirming, setConfirming] = useState(false);
  const outcome = params.get('calendar');

  const status = connection.data?.status ?? 'not_connected';

  return (
    <Card id="calendar" title="My calendar">
      <div aria-live="polite" className="mb-3 flex flex-col gap-2">
        {outcome === 'connected' && <Notice>Your Google calendar is connected.</Notice>}
        {outcome === 'error' && (
          <Alert error={new Error('Google did not connect your calendar. Try connecting again.')} />
        )}
      </div>

      {connection.isPending && <Loading>Loading your calendar…</Loading>}
      <Alert error={connection.error} />

      {connection.data !== undefined && (
        <div className="flex flex-col gap-3">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            Status:{' '}
            {status === 'connected' && (
              <Badge tone="good" symbol="✓">
                Connected
              </Badge>
            )}
            {status === 'needs_reconnect' && (
              <Badge tone="bad" symbol="!">
                Needs reconnect
              </Badge>
            )}
            {status === 'not_connected' && <Badge symbol="○">Not connected</Badge>}
            {connection.data.googleEmail != null && (
              <span className="break-all">{connection.data.googleEmail}</span>
            )}
          </p>
          {status === 'needs_reconnect' && (
            <p className="text-sm text-red-800 dark:text-red-300">
              Google stopped accepting the saved connection. Appointments cannot be booked on your
              calendar until you connect again.
            </p>
          )}
          {!connection.data.configured && (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Google Calendar is not set up on this server yet, so it cannot be connected.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {status !== 'connected' && (
              <Button
                type="button"
                disabled={!connection.data.configured}
                busy={connect.isPending}
                busyLabel="Opening Google…"
                onClick={() => {
                  connect.mutate();
                }}
              >
                {status === 'needs_reconnect' ? 'Reconnect' : 'Connect Google Calendar'}
              </Button>
            )}
            {status !== 'not_connected' &&
              (!confirming ? (
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
                <>
                  <span className="text-sm">Disconnect your calendar?</span>
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
                </>
              ))}
          </div>
          <Alert error={connect.error} />
          <Alert error={disconnect.error} />
        </div>
      )}
    </Card>
  );
}

function NotificationsSection() {
  const settings = useNotificationSettings();
  const save = useSaveNotificationSettings();
  const test = useSendTestAlert();
  const [chatId, setChatId] = useState('');

  const saved = settings.data?.telegramChatId;
  useEffect(() => {
    if (settings.data !== undefined) setChatId(settings.data.telegramChatId ?? '');
  }, [settings.data]);

  const bot = settings.data?.botUsername;

  return (
    <Card id="notifications" title="My notifications">
      {settings.isPending && <Loading>Loading your alert settings…</Loading>}
      <Alert error={settings.error} />

      <div className="mb-4 text-sm text-slate-700 dark:text-slate-300">
        <p>
          Get a Telegram message when a lead needs you. Before saving, open Telegram, find{' '}
          <strong>{bot != null ? `@${bot}` : 'the workspace bot'}</strong> and press{' '}
          <strong>Start</strong>. A bot cannot message you until you do.
        </p>
        <p className="mt-2">
          To find your chat id, message <strong>@userinfobot</strong> in Telegram. It replies with
          your numeric id, which is what goes below.
        </p>
      </div>

      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(chatId.trim() === '' ? null : chatId.trim());
        }}
      >
        <Field
          label="Telegram chat id"
          inputMode="numeric"
          value={chatId}
          onChange={(event) => {
            setChatId(event.target.value);
          }}
          hint={
            settings.data === undefined
              ? undefined
              : settings.data.telegramConnected === true
                ? 'Alerts are on.'
                : 'Alerts are off until a chat id is saved.'
          }
        />
        <div aria-live="polite" className="flex flex-col gap-2">
          <Alert error={save.error} />
          {save.isSuccess && <Notice>Saved.</Notice>}
          <Alert error={test.error} />
          {test.isSuccess && <Notice>Test alert sent. Check Telegram.</Notice>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={save.isPending} busyLabel="Saving…">
            Save
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={saved == null || saved === ''}
            busy={test.isPending}
            busyLabel="Sending…"
            onClick={() => {
              test.mutate();
            }}
          >
            Send test alert
          </Button>
        </div>
      </form>
    </Card>
  );
}
