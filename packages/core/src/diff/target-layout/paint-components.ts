/** Independent paint observations, never inputs to target/DOM layout matching. */
export interface SolidPaintComponent {
  box: { x: number; y: number; width: number; height: number };
  fill: [number, number, number];
  solidArea: number;
  /** One member pixel disambiguates overlapping same-color component bounds. */
  seed: { x: number; y: number };
}

export interface PaintComponentEvidence {
  width: number;
  height: number;
  /** Complete extents of selected full-image components, including text holes.
   * Excludes the estimated background, area <16 and bounds smaller than24x16. */
  components: SolidPaintComponent[];
  omittedComponents: number;
  /** A complexity limit returns no partial inventory. */
  complexity: boolean;
}
