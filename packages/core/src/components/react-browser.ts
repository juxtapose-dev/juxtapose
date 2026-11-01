import 'bippy/install-hook-only';
import {
  collectReactComponents,
  type ReactComponentSnapshot,
  type ReactSnapshotOptions,
} from './react.js';
import { createReactComponentProvider } from './react-provider.js';
/** This entry is bundled before React initialization; capture itself is a single settled observation. */
export function collect(
  elements: readonly Element[],
  options: ReactSnapshotOptions = {},
): ReactComponentSnapshot {
  if (options.excludedRoots?.length)
    return collectReactComponents(elements, undefined, options);
  const result = createReactComponentProvider();
  return result.status === 'available'
    ? collectReactComponents(elements, result.provider, options)
    : {
        framework: 'react',
        runtimeVersion: result.runtimeVersion,
        relation: 'rendered-parent',
        status: 'unavailable',
        reason: result.reason,
        truncated: false,
        nodes: [],
      };
}
