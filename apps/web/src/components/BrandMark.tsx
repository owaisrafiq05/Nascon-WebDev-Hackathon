/** A small ledger mark. Decorative: the product name sits beside it. */
export function BrandMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#13243A" />
      <rect x="7" y="8" width="18" height="2.2" fill="#E0B15A" />
      <rect x="7" y="15" width="12" height="2.2" fill="#F7F4EE" />
      <rect x="7" y="22" width="18" height="2.2" fill="#F7F4EE" opacity="0.5" />
    </svg>
  );
}
