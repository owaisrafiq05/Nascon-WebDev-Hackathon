import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Pager } from '../../components/Pager.js';
import { TextArea } from '../../components/TextArea.js';
import { BACK_LINK, Badge, KICKER_CLASS, Loading, MUTED, PageContainer } from '../../components/ui.js';
import { formatDateTime } from '../../lib/format.js';
import {
  MESSAGE_STATUS_LABELS,
  useRetryMessage,
  useSendReply,
  useThread,
  type Message,
} from './messaging-api.js';

/** One conversation: messages oldest first, delivery state in words, a reply box (I1). */
export function ConversationThreadPage() {
  const { conversationId = '' } = useParams();
  // Oldest first means the newest messages are on the last page.
  const [page, setPage] = useState<number | null>(null);
  const thread = useThread(conversationId, page ?? 1);
  const reply = useSendReply(conversationId);
  const retry = useRetryMessage();
  const [body, setBody] = useState('');

  const totalPages = thread.data?.pageInfo.totalPages;
  useEffect(() => {
    if (page === null && totalPages !== undefined) setPage(Math.max(1, totalPages));
  }, [page, totalPages]);

  if (thread.isPending) {
    return (
      <PageContainer>
        <Loading>Loading the conversation…</Loading>
      </PageContainer>
    );
  }
  if (thread.error !== null) {
    return (
      <PageContainer>
        <Alert error={thread.error} />
        <p className="mt-4">
          <Link to="/conversations" className="text-sm underline">
            Back to conversations
          </Link>
        </p>
      </PageContainer>
    );
  }

  const { conversation, items, pageInfo } = thread.data;
  const optedOut = conversation.optedOut === true;

  return (
    <PageContainer>
      <p className="text-sm">
        <Link to="/conversations" className={BACK_LINK}>
          ← Conversations
        </Link>
      </p>
      <p className={`mt-3 ${KICKER_CLASS}`}>Work</p>
      <h1 className="mt-1 text-2xl font-semibold break-words text-slate-900 sm:text-3xl dark:text-slate-50">
        {conversation.contactName ?? conversation.address ?? 'Conversation'}
      </h1>
      <p className={MUTED}>
        {(conversation.channel ?? 'message').toUpperCase()} · {conversation.address ?? '—'}
        {conversation.contactId != null && (
          <>
            {' · '}
            <Link to={`/contacts/${conversation.contactId}`} className="underline">
              Open contact
            </Link>
          </>
        )}
      </p>

      <Pager pageInfo={pageInfo} onPage={setPage} />

      <ol aria-label="Messages" className="mt-4 flex flex-col gap-3">
        {items.length === 0 && <li className={MUTED}>No messages yet.</li>}
        {items.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            retrying={retry.isPending && retry.variables === message.id}
            onRetry={() => {
              retry.mutate(message.id);
            }}
          />
        ))}
      </ol>

      <div aria-live="polite" className="mt-4 flex flex-col gap-2">
        <Alert error={retry.error} />
        {retry.isSuccess && retry.data.status !== 'failed' && (
          <Notice>
            Retry sent. Status: {MESSAGE_STATUS_LABELS[retry.data.status] ?? retry.data.status}.
          </Notice>
        )}
        {retry.isSuccess && retry.data.status === 'failed' && (
          <Alert
            error={new Error(`Retry failed: ${retry.data.failureReason ?? 'unknown reason'}`)}
          />
        )}
      </div>

      <form
        noValidate
        className="mt-6 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim() === '' || optedOut) return;
          reply.mutate(body.trim(), {
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
          label="Reply"
          value={body}
          disabled={optedOut}
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
        <div aria-live="polite">
          <Alert error={reply.error} />
          {reply.isSuccess && reply.data.status === 'failed' && (
            <Alert
              error={new Error(`Message failed: ${reply.data.failureReason ?? 'unknown reason'}`)}
            />
          )}
          {reply.isSuccess && reply.data.status !== 'failed' && (
            <Notice>
              Message {MESSAGE_STATUS_LABELS[reply.data.status]?.toLowerCase() ?? reply.data.status}
              .
            </Notice>
          )}
        </div>
        <div>
          <Button type="submit" disabled={optedOut} busy={reply.isPending} busyLabel="Sending…">
            Send reply
          </Button>
        </div>
      </form>
    </PageContainer>
  );
}

function MessageItem({
  message,
  retrying,
  onRetry,
}: {
  message: Message;
  retrying: boolean;
  onRetry: () => void;
}) {
  const inbound = message.direction === 'inbound';
  const failed = message.status === 'failed' || message.status === 'undelivered';

  return (
    <li
      className={`max-w-full rounded-lg border px-4 py-3 sm:max-w-[85%] ${
        inbound
          ? 'self-start border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900'
          : 'self-end border-navy border-l-4 bg-[#FBF6EC] dark:border-brass-bright dark:bg-slate-800'
      }`}
    >
      <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">
        {inbound ? 'From the contact' : 'Sent by us'} · {formatDateTime(message.createdAt)}
      </p>
      <p className="mt-1 text-sm break-words whitespace-pre-wrap text-slate-900 dark:text-slate-100">
        {message.body}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={failed ? 'bad' : 'neutral'} symbol={failed ? '!' : '•'}>
          {MESSAGE_STATUS_LABELS[message.status] ?? message.status}
        </Badge>
        {failed && message.failureReason != null && (
          <span className="text-red-800 dark:text-red-300">{message.failureReason}</span>
        )}
      </p>
      {failed && !inbound && (
        <div className="mt-2">
          <Button
            type="button"
            variant="secondary"
            busy={retrying}
            busyLabel="Retrying…"
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      )}
    </li>
  );
}
