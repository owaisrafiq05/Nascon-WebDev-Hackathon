import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { identityFixture, stubApi } from '../../test/fetch.js';
import { renderWithProviders } from '../../test/render.js';
import { AvailabilityControl, availabilityMessage } from './AvailabilityControl.js';
import { LeadsPage } from './LeadsPage.js';

const lead = (overrides: Record<string, unknown>) => ({
  id: 'l1',
  contactId: 'c1',
  source: 'form',
  sourceLabel: 'Website form',
  status: 'open',
  assigneeMembershipId: 'm1',
  assigneeEmail: 'me@example.com',
  assignmentStatus: 'pending_ack',
  escalationCount: 0,
  ownerUnavailable: false,
  acknowledgedAt: null,
  acknowledgementDeadline: new Date(Date.now() + 80_000).toISOString(),
  version: 1,
  createdAt: new Date().toISOString(),
  ...overrides,
});

const page = { page: 1, limit: 25, total: 2, totalPages: 1 };

describe('LeadsPage (F3.4)', () => {
  it('shows the countdown, status in words and the unavailable badge', async () => {
    stubApi({
      'GET /api/auth/me': identityFixture(['crm.record.view']),
      'GET /api/availability': { members: [] },
      'GET /api/leads': {
        items: [
          lead({}),
          lead({
            id: 'l2',
            sourceLabel: 'Referral',
            ownerUnavailable: true,
            acknowledgedAt: '2026-01-01T00:00:00Z',
            assignmentStatus: 'acknowledged',
          }),
        ],
        pageInfo: page,
      },
    });
    renderWithProviders(<LeadsPage />);

    expect(await screen.findByText(/Status: Waiting for acknowledgement/)).toBeInTheDocument();
    expect(screen.getByText(/left$/)).toBeInTheDocument();
    expect(screen.getByText('Owner unavailable')).toBeInTheDocument();
  });

  it('calls the acknowledge endpoint when the button is pressed', async () => {
    const calls = stubApi({
      'GET /api/auth/me': identityFixture(['crm.record.view']),
      'GET /api/availability': { members: [] },
      'GET /api/leads': { items: [lead({})], pageInfo: { ...page, total: 1 } },
      'POST /api/leads/l1/acknowledge': { acknowledged: true },
    });
    const user = userEvent.setup();
    renderWithProviders(<LeadsPage />);

    await user.click(
      await screen.findByRole('button', { name: /acknowledge lead from website form/i }),
    );

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/leads/l1/acknowledge')).toBe(
        true,
      );
    });
    expect(await screen.findByText('Lead acknowledged.')).toBeInTheDocument();
  });

  it("does not offer Acknowledge on someone else's lead", async () => {
    stubApi({
      'GET /api/auth/me': identityFixture(['crm.record.view']),
      'GET /api/availability': { members: [] },
      'GET /api/leads': {
        items: [lead({ assigneeMembershipId: 'm2' })],
        pageInfo: { ...page, total: 1 },
      },
    });
    renderWithProviders(<LeadsPage />);

    await screen.findByText('Website form');
    expect(screen.queryByRole('button', { name: /acknowledge/i })).not.toBeInTheDocument();
  });
});

describe('availability (F3.2, F3.6)', () => {
  it('words the reassigned and flagged counts', () => {
    expect(availabilityMessage(2, 1)).toBe(
      '2 unacknowledged leads were reassigned; 1 acknowledged lead stays with you, flagged owner unavailable.',
    );
  });

  it('shows the counts after the member changes their status', async () => {
    const calls = stubApi({
      'GET /api/auth/me': identityFixture(['crm.record.view']),
      'GET /api/availability': {
        members: [
          {
            membershipId: 'm1',
            email: 'me@example.com',
            availabilityStatus: 'available',
            openLeadCount: 3,
          },
        ],
      },
      'PATCH /api/availability/m1': { reassignedLeadIds: ['a', 'b'], flaggedLeadIds: ['c'] },
    });
    const user = userEvent.setup();
    renderWithProviders(<AvailabilityControl />);

    await screen.findByRole('option', { name: 'Busy' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Update availability' })).toBeEnabled();
    });
    await user.selectOptions(screen.getByLabelText('My availability'), 'on_leave');
    await user.click(screen.getByRole('button', { name: 'Update availability' }));

    expect(await screen.findByText(/2 unacknowledged leads were reassigned/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'on_leave' });
  });
});
