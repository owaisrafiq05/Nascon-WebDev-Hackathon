import type { HealthResponse } from '@ubmp/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../test/render.js';
import { SystemStatusCard } from './SystemStatusCard.js';

const healthy: HealthResponse = {
  status: 'ok',
  service: 'ubmp-server',
  version: '0.0.0',
  environment: 'test',
  uptimeSeconds: 42,
  timestamp: '2026-01-01T00:00:00.000Z',
  dependencies: { database: 'up' },
};

function stubHealth(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
}

describe('SystemStatusCard', () => {
  it('shows a loading state while the request is in flight (Q10)', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    renderWithProviders(<SystemStatusCard />);

    expect(screen.getByText('Contacting the API…')).toBeInTheDocument();
  });

  it('calls the health endpoint through the /api prefix the dev server proxies', async () => {
    stubHealth(healthy);

    renderWithProviders(<SystemStatusCard />);
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/health');
  });

  it('renders the health figures once loaded', async () => {
    stubHealth(healthy);

    renderWithProviders(<SystemStatusCard />);

    expect(await screen.findByText(/All systems operational/)).toBeInTheDocument();
    expect(screen.getByText('ubmp-server')).toBeInTheDocument();
    expect(screen.getByText('42s')).toBeInTheDocument();
    expect(screen.getByText(/Connected/)).toBeInTheDocument();
  });

  it('says the database is not connected when the API reports it as down', async () => {
    stubHealth({ ...healthy, status: 'degraded', dependencies: { database: 'down' } });

    renderWithProviders(<SystemStatusCard />);

    expect(await screen.findByText(/degraded dependency/)).toBeInTheDocument();
    expect(screen.getByText(/Not connected/)).toBeInTheDocument();
  });

  it('carries each status in words, not only in colour (Q8)', async () => {
    stubHealth(healthy);

    renderWithProviders(<SystemStatusCard />);
    const status = await screen.findByText(/All systems operational/);

    // The word itself is the signal; the colour class is decoration.
    expect(status.textContent).toMatch(/All systems operational/);
  });

  it('shows the error message and the hint when the API fails (Q10)', async () => {
    stubHealth(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'The API is not available.',
          hint: 'Start the API with pnpm dev.',
        },
      },
      503,
    );

    renderWithProviders(<SystemStatusCard />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The API is not available.');
    expect(alert).toHaveTextContent('Start the API with pnpm dev.');
  });

  it('refetches when the user presses the button, which is reachable by keyboard (Q8)', async () => {
    stubHealth(healthy);
    const user = userEvent.setup();

    renderWithProviders(<SystemStatusCard />);
    await screen.findByText(/All systems operational/);

    const button = screen.getByRole('button', { name: /check again/i });
    button.focus();
    expect(button).toHaveFocus();

    const callsBefore = vi.mocked(fetch).mock.calls.length;
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('is labelled as a region so it appears in the accessibility tree', async () => {
    stubHealth(healthy);

    renderWithProviders(<SystemStatusCard />);

    expect(await screen.findByRole('region', { name: 'API status' })).toBeInTheDocument();
  });
});
