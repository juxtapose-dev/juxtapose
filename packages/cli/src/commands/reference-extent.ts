import type { DesignReferenceExtent } from '@juxtapose/core';

/** How the capture's extent differs from the target, in words an agent can act on. */
export function extentGuidance(extent: DesignReferenceExtent): string {
  const parts: string[] = [];
  if (extent.dh)
    parts.push(`${Math.abs(extent.dh)} px ${extent.dh < 0 ? 'shorter' : 'taller'}`);
  if (extent.dw)
    parts.push(`${Math.abs(extent.dw)} px ${extent.dw < 0 ? 'narrower' : 'wider'}`);
  return `current is ${parts.join(' and ')} than the target (${extent.current.width}x${extent.current.height} vs ${extent.reference.width}x${extent.reference.height}); ${extent.missingAreaPixels} px exist in only one image and count as mismatched`;
}
