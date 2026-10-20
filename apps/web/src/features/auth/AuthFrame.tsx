import type { ReactNode } from 'react';

import { BrandMark } from '../../components/BrandMark.js';

/** Shared gate for sign-in, sign-up, and invite acceptance. */
export function AuthFrame({
  kicker,
  headline,
  lede,
  children,
}: {
  kicker: string;
  headline: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(22rem,34rem)]">
      <aside className="bg-navy px-5 py-6 text-slate-50 sm:px-8 lg:flex lg:flex-col lg:justify-between lg:px-12 lg:py-12">
        <div>
          <div className="flex items-center gap-3">
            <BrandMark />
            <div className="min-w-0">
              <p className="font-mono text-sm font-semibold tracking-tight">UBMP</p>
              <p className="text-xs text-[#D5CBBA]">Unified operations</p>
            </div>
          </div>

          <div className="mt-8 hidden max-w-md lg:block">
            <p className="font-mono text-xs font-medium tracking-[0.16em] text-brass-bright uppercase">
              {kicker}
            </p>
            <p className="mt-3 font-mono text-3xl leading-tight font-semibold tracking-tight text-balance">
              {headline}
            </p>
            <p className="mt-4 text-sm leading-relaxed text-[#D5CBBA]">{lede}</p>
            <ul className="mt-8 flex flex-col gap-3 text-sm text-[#D5CBBA]">
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brass-bright"
                />
                Every lead has an owner and a clock.
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brass-bright"
                />
                Pipeline, payments, and appointments on one desk.
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brass-bright"
                />
                Every change is written to the audit log.
              </li>
            </ul>
          </div>
        </div>
        <p className="mt-6 hidden font-mono text-xs tracking-wide text-[#B5A894] lg:block">
          Service companies · one workspace
        </p>
      </aside>

      <div className="desk-rise flex items-center bg-slate-50 px-4 py-8 sm:px-8 lg:py-12 dark:bg-slate-950">
        <div className="mx-auto w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}

export const AUTH_LINK =
  'font-medium text-navy underline decoration-brass-bright decoration-2 underline-offset-4 focus-visible:ring-2 focus-visible:ring-navy focus-visible:outline-none dark:text-brass-bright dark:focus-visible:ring-brass-bright';
