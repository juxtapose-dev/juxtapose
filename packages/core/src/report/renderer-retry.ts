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
  const lines = [
    `${resolved.length} stories passed only after a fresh retry.`,
    `${retries.length - capped} fresh retries; ${capped} failures left without a retry because the limit was reached.`,
  ];
  if (resolved.length) {
    lines.push(
      'To use a fresh renderer for these stories, add:',
      JSON.stringify(
        {
          stories: Object.fromEntries(
            resolved.map((r) => [r.storyId, { renderer: { shared: false } }]),
          ),
        },
        null,
        2,
      ),
    );
  }
  return lines.join('\n');
}
