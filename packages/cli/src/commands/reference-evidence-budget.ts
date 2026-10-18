/** A target, with room to finish one whole fact instead of a byte cliff.
 * The team trace needed another JSON read after useful paint was omitted at
 * 3,072 bytes. Keep the overrun bounded without truncating any field value. */
export const FOCUSED_TARGET_BYTES = 3072;
export const FOCUSED_MAX_BYTES = 4096;
export const evidenceBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));

/** Once an atom crosses the target, later atoms wait for requested detail. */
export function fitsFocusedEvidence(current: unknown, candidate: unknown): boolean {
  const bytes = evidenceBytes(candidate);
  return (
    bytes <= FOCUSED_MAX_BYTES &&
    (bytes <= FOCUSED_TARGET_BYTES || evidenceBytes(current) <= FOCUSED_TARGET_BYTES)
  );
}
