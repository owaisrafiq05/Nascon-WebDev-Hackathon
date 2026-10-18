import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTicker } from './ticker.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createTicker', () => {
  it('does not tick before it is started', async () => {
    const onTick = vi.fn();
    createTicker({ intervalMs: 100, onTick });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(onTick).not.toHaveBeenCalled();
  });

  it('ticks once per interval', async () => {
    const onTick = vi.fn();
    const ticker = createTicker({ intervalMs: 100, onTick });
    ticker.start();

    await vi.advanceTimersByTimeAsync(350);

    expect(onTick).toHaveBeenCalledTimes(3);
    await ticker.stop();
  });

  it('can run the first tick immediately', async () => {
    const onTick = vi.fn();
    const ticker = createTicker({ intervalMs: 100, onTick, runImmediately: true });
    ticker.start();

    await vi.advanceTimersByTimeAsync(0);

    expect(onTick).toHaveBeenCalledTimes(1);
    await ticker.stop();
  });

  it('numbers the ticks from 1', async () => {
    const seen: number[] = [];
    const ticker = createTicker({
      intervalMs: 100,
      onTick: ({ tick }) => {
        seen.push(tick);
      },
    });
    ticker.start();

    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([1, 2]);
    await ticker.stop();
  });

  it('never overlaps ticks, even when one tick outlasts the interval (F3.8, Q5)', async () => {
    let active = 0;
    let maxActive = 0;

    const ticker = createTicker({
      intervalMs: 50,
      onTick: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 200));
        active -= 1;
      },
    });
    ticker.start();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(maxActive).toBe(1);
    await ticker.stop();
  });

  it('keeps running after a tick throws, and reports the failure', async () => {
    const onError = vi.fn();
    let calls = 0;

    const ticker = createTicker({
      intervalMs: 100,
      onError,
      onTick: () => {
        calls += 1;
        if (calls === 1) throw new Error('one bad job');
      },
    });
    ticker.start();

    await vi.advanceTimersByTimeAsync(350);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toEqual({ tick: 1 });
    expect(calls).toBe(3);
    await ticker.stop();
  });

  it('stops scheduling after stop(), including when stop happens mid-tick', async () => {
    const onTick = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const ticker = createTicker({ intervalMs: 50, onTick });
    ticker.start();

    await vi.advanceTimersByTimeAsync(60); // tick 1 has started and is still running
    const stopped = ticker.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopped;

    expect(ticker.isRunning()).toBe(false);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: start() twice does not double the rate', async () => {
    const onTick = vi.fn();
    const ticker = createTicker({ intervalMs: 100, onTick });

    ticker.start();
    ticker.start();
    await vi.advanceTimersByTimeAsync(350);

    expect(onTick).toHaveBeenCalledTimes(3);
    await ticker.stop();
  });
});
