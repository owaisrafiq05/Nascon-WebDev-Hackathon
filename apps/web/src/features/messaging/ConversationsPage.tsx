import { PERMISSIONS } from '@ubmp/domain';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Pager } from '../../components/Pager.js';
import { Empty, Loading, MUTED, PageContainer, PageTitle, ROW_CLASS } from '../../components/ui.js';
import { formatDateTime } from '../../lib/format.js';
import { useSession } from '../auth/session.js';
import { useConversations } from './messaging-api.js';

export function ConversationsPage() {
  const session = useSession();
  const canSeeAll =
    session.data?.membership.permissions.includes(PERMISSIONS.MEMBERS_MANAGE) ?? false;
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const conversations = useConversations({ mine: !(canSeeAll && all), page });

  return (
    <PageContainer>
      <PageTitle kicker="Work" sub="WhatsApp and SMS threads with your contacts.">
        Conversations
      </PageTitle>

      {canSeeAll && (
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={all}
            onChange={(event) => {
              setAll(event.target.checked);
              setPage(1);
            }}
          />
          All conversations
        </label>
      )}

      {conversations.isPending && <Loading>Loading conversations…</Loading>}
      {conversations.error !== null && (
        <div className="flex flex-col gap-3">
          <Alert error={conversations.error} />
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void conversations.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        </div>
      )}
      {conversations.data?.items.length === 0 && <Empty>No conversations yet.</Empty>}
      {conversations.data !== undefined && conversations.data.items.length > 0 && (
        <>
          <ul className="flex flex-col gap-2">
            {conversations.data.items.map((conversation) => (
              <li key={conversation.id} className={ROW_CLASS}>
                <div className="min-w-0">
                  <Link
                    to={`/conversations/${conversation.id}`}
                    className="font-medium break-words text-slate-900 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none dark:text-slate-100"
                  >
                    {conversation.contactName ?? conversation.address ?? 'Conversation'}
                  </Link>
                  <p className={`${MUTED} break-words`}>
                    {(conversation.channel ?? 'message').toUpperCase()} ·{' '}
                    {conversation.address ?? '—'}
                    {conversation.optedOut === true && ' · Opted out of messaging'}
                  </p>
                  <p className="text-sm break-words text-slate-800 dark:text-slate-200">
                    {conversation.lastMessagePreview ?? 'No messages'}
                  </p>
                </div>
                <p className={MUTED}>{formatDateTime(conversation.lastMessageAt)}</p>
              </li>
            ))}
          </ul>
          <Pager pageInfo={conversations.data.pageInfo} onPage={setPage} />
        </>
      )}
    </PageContainer>
  );
}
