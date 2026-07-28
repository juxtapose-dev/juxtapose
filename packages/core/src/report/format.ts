// How the mismatch number is written, everywhere it is written.
//
// Shared rather than copied because it is a product rule, not a formatter: a
// real change displaying as "0.00%" reads as a tool bug, so anything below the
// rounding floor says "<0.01%" instead. Five call sites had their own copy.

/** Never show "0.00%" next to the word "changed" — it reads as a tool bug. */
export function formatPercent(pct: number): string {
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  return pct > 0 ? '<0.01%' : '0%';
}
