import { useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { TextArea } from '../../components/TextArea.js';
import { MESSAGE_STATUS_LABELS, useSendToContact, useSetOptOut } from './messaging-api.js';

/** Send a message to a contact and toggle their messaging opt-out (I1). */
export function ContactMessaging({
  contactId,
  optedOut,
}: {
  contactId: string;
  optedOut: boolean;
}) {
  const send = useSendToContact(contactId);
  const optOut = useSetOptOut(contactId);
  const [body, setBody] = useState('');

  return (
    <div className="mt-4 flex flex-col gap-4">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim() === '' || optedOut) return;
          send.mutate(body.trim(), {
            onSuccess: () => {
              setBody('');
            },
          });
        }}
      >
        {optedOut && (
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            ◐ This contact opted out of messaging. You cannot send them messages.
          </p>
        )}
        <TextArea
          label="Send message"
          value={body}
          disabled={optedOut}
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
        <div aria-live="polite">
          <Alert error={send.error} />
          {send.isSuccess && send.data.message.status === 'failed' && (
            <Alert
              error={
                new Error(`Message failed: ${send.data.message.failureReason ?? 'unknown reason'}`)
              }
            />
          )}
          {send.isSuccess && send.data.message.status !== 'failed' && (
            <Notice>
              Message{' '}
              {MESSAGE_STATUS_LABELS[send.data.message.status]?.toLowerCase() ??
                send.data.message.status}
              .
            </Notice>
          )}
        </div>
        <div>
          <Button type="submit" disabled={optedOut} busy={send.isPending} busyLabel="Sending…">
            Send message
          </Button>
        </div>
      </form>

      <div>
        <Button
          type="button"
          variant="secondary"
          busy={optOut.isPending}
          busyLabel="Saving…"
          onClick={() => {
            optOut.mutate(!optedOut);
          }}
        >
          {optedOut ? 'Allow messaging again' : 'Mark as opted out of messaging'}
        </Button>
        <div aria-live="polite" className="mt-2">
          <Alert error={optOut.error} />
          {optOut.isSuccess && (
            <Notice>
              {optOut.data.optedOut
                ? 'Contact opted out of messaging.'
                : 'Messaging allowed again.'}
            </Notice>
          )}
        </div>
      </div>
    </div>
  );
}
