import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { stubApi } from '../../test/fetch.js';
import { renderWithProviders } from '../../test/render.js';
import { Dashboard } from './Dashboard.js';

const dashboard = {
  range: 'today',
  scope: 'company',
  currency: 'USD',
  generatedAt: '2026-01-01T00:00:00.000Z',
  hiddenTiles: [] as string[],
  tiles: [
    {
      id: 'new_leads',
      label: 'New leads',
      value: 4,
      display: '4',
      description: 'Leads created in the range',
      drillDown: { path: '/leads', query: { createdFrom: '2026-01-01T00:00:00.000Z' } },
    },
    {
      id: 'open_pipeline_value',
      label: 'Open pipeline value',
      value: 1000,
      display: '$10.00',
      description: 'Value of open opportunities',
      drillDown: null,
      detail: {
        byStage: [
          { stageId: 's1', stageName: 'Qualified', total: 1000, count: 1, display: '$10.00' },
        ],
      },
    },
    {
      id: 'availability',
      label: 'Team availability',
      value: 2,
      display: '2 available',
      description: '',
      drillDown: null,
      detail: { available: 2, busy: 1, on_leave: 0, offline: 3, availableForAssignment: 2 },
    },
  ],
};

describe('Dashboard (P5)', () => {
  it('renders tiles, a drill-down link, the stage breakdown and availability counts', async () => {
    stubApi({ 'GET /api/dashboard': dashboard });
    renderWithProviders(<Dashboard />);

    const link = await screen.findByRole('link', { name: 'New leads' });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toMatch(/range=today&tz=/);
    expect(link).toHaveAttribute('href', '/leads?createdFrom=2026-01-01T00%3A00%3A00.000Z');
    expect(screen.getByText('Qualified')).toBeInTheDocument();
    expect(screen.getByText('Busy: 1')).toBeInTheDocument();
    expect(screen.getByText('Offline: 3')).toBeInTheDocument();
  });

  it('hides a tile through Customize and saves the preference', async () => {
    const calls = stubApi({
      'GET /api/dashboard': dashboard,
      'PUT /api/dashboard/preferences': (call: { body: unknown }) => call.body,
    });
    const user = userEvent.setup();
    renderWithProviders(<Dashboard />);

    await screen.findByRole('link', { name: 'New leads' });
    await user.click(screen.getByRole('button', { name: 'Customize' }));
    await user.click(screen.getByRole('checkbox', { name: 'New leads' }));

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'New leads' })).not.toBeInTheDocument();
    });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({ hiddenTiles: ['new_leads'] });
    // Other tiles stay.
    expect(screen.getByRole('heading', { name: 'Open pipeline value' })).toBeInTheDocument();
  });

  it('does not render tiles the server reports as hidden', async () => {
    stubApi({ 'GET /api/dashboard': { ...dashboard, hiddenTiles: ['new_leads'] } });
    renderWithProviders(<Dashboard />);

    await screen.findByRole('heading', { name: 'Open pipeline value' });
    expect(screen.queryByRole('link', { name: 'New leads' })).not.toBeInTheDocument();
  });

  it('shows an error with a Retry button (Q10)', async () => {
    const calls = stubApi({});
    const user = userEvent.setup();
    renderWithProviders(<Dashboard />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    const before = calls.length;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(before);
    });
  });
});
