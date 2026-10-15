import type { DiffResult } from '../types.js';
import { compareCodeUnits } from '../diff/structural/deltas.js';

/** Shared wording for terminal, HTML, PR, handoff and machine consumers. */
export function describeRendererRetries(results: readonly DiffResult[]): string {
  const retries = results.filter((r) => r.rendererRetry);
  if (!retries.length) return '';
  const resolved = retries
    .filter((r) => r.rendererRetry?.outcome === 'resolved')
    .sort((a, b) => compareCodeUnits(a.storyId, b.storyId));
  const capped = retries.filter((r) => r.rendererRetry?.outcome === 'cap').length;
  const pulsed = resolved.filter(
    (r) => r.rendererRetry?.resolvedBy === 'cache-pulse',
  ).length;
  const lines = [
    `${resolved.length - pulsed} stories passed only after a fresh retry.`,
    `${pulsed} stories passed after a cache-pulse retry.`,
    `${retries.length - capped} stories retried; ${capped} failures left without a retry because the limit was reached.`,
  ];
  if (resolved.length) {
    lines.push(
      'To apply the successful recovery before capturing these stories, add:',
      JSON.stringify(
        {
          stories: Object.fromEntries(
            resolved.map((r) => [
              r.storyId,
              {
                renderer:
                  r.rendererRetry?.resolvedBy === 'cache-pulse'
                    ? { shared: true, clearResourceCache: true }
                    : { shared: false },
              },
            ]),
          ),
        },
        null,
        2,
      ),
    );
  }
  return lines.join('\n');
}
