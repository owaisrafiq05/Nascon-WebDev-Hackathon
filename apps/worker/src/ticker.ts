/**
 * The worker's single loop primitive.
 *
 * Ticks never overlap: the next tick is scheduled only after the previous one has
 * settled. That matters because from P4 onwards the tick body claims persisted
 * `scheduled_jobs` with a lease, and two overlapping claims on one slow tick could
 * escalate the same lead twice (F3.8, Q5).
 *
 * A thrown tick is reported and the loop continues, so one bad job cannot stop the
 * escalation of every other lead.
 */
export interface TickContext {
  /** 1 for the first tick of this ticker. */
  readonly tick: number;
}

export interface TickerOptions {
  readonly intervalMs: number;
  readonly onTick: (context: TickContext) => void | Promise<void>;
  readonly onError?: (error: unknown, context: TickContext) => void;
  /** Run the first tick straight away instead of waiting one interval. */
  readonly runImmediately?: boolean;
}

export interface Ticker {
  start(): void;
  /** Resolves once the loop is stopped and any in-flight tick has settled. */
  stop(): Promise<void>;
  isRunning(): boolean;
}

export function createTicker({
  intervalMs,
  onTick,
  onError,
  runImmediately = false,
}: TickerOptions): Ticker {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();
  let tick = 0;

  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      void runTick();
    }, delayMs);
  };

  const runTick = async (): Promise<void> => {
    if (!running) return;

    tick += 1;
    const context: TickContext = { tick };

    inFlight = (async () => {
      try {
        await onTick(context);
      } catch (error) {
        onError?.(error, context);
      }
    })();

    await inFlight;

    // Re-check: stop() may have been called while the tick was running, and it
    // must not be followed by another tick.
    if (running) schedule(intervalMs);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      schedule(runImmediately ? 0 : intervalMs);
    },

    async stop(): Promise<void> {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await inFlight;
    },

    isRunning(): boolean {
      return running;
    },
  };
}
