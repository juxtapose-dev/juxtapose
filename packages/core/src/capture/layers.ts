// How a capture's project, story and call layers stack. This is the one
// place the order lives: captureStory (to capture) and explainCapture (to say
// where each value came from) both call it, so they cannot disagree.
//
// Lowest first: the project config, the story's own params (variants, `stories`
// overrides and live params already folded in), the call (CLI flags, MCP
// arguments).

import type { FreezeParams, NetworkParams, SettleParams } from '../config/schema.js';
import type { StoryParams } from '../types.js';
import { mergeNetwork } from './network-rules.js';
import { mergeFreeze } from './freeze.js';
import { layerScalars, mergeSettleLayers, type SettleLayer } from './settle-options.js';

export interface CaptureLayers {
  project?: SettleLayer;
  call?: SettleLayer;
}

/** `network` for one capture, read before navigation from the params known
 *  then (live params arrive too late). */
export function layerNetwork(
  layers: CaptureLayers | undefined,
  params: StoryParams,
): NetworkParams | undefined {
  return mergeNetwork(
    mergeNetwork(layers?.project?.network, params.network),
    layers?.call?.network,
  );
}

/** `freeze` for one capture, field by field, read before navigation like
 *  `network`: the init script must be in place before the story's document. */
export function layerFreeze(
  layers: CaptureLayers | undefined,
  params: StoryParams,
): FreezeParams | undefined {
  return mergeFreeze(
    mergeFreeze(layers?.project?.freeze, params.freeze),
    layers?.call?.freeze,
  );
}

/** `waitForSelector` and `delay` (call > story > project) and `settle`
 *  (merged field by field), once live params are in `params`. */
export function layerCapture(
  layers: CaptureLayers | undefined,
  params: StoryParams,
): { scalars: Pick<StoryParams, 'waitForSelector' | 'delay'>; settle?: SettleParams } {
  const settle = mergeSettleLayers(
    layers?.project?.settle,
    params.settle,
    layers?.call?.settle,
  );
  return {
    scalars: layerScalars(layers?.project, params, layers?.call),
    ...(settle ? { settle } : {}),
  };
}
