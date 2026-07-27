// The review API's contract.
//
// This is deliberately the stable surface, not the panel. A Storybook addon,
// a Ladle UI, an MCP server and a CLI all want the same operations; making
// HTTP the contract means each is a skin rather than a reimplementation.

import type { RunReport, StoryManifest } from '@juxtapose/core';

/** What the panel polls for. One request, everything it needs to render. */
export interface ReviewBundle {
  report: RunReport | null;
  /** Story ids approved since the run, so the UI can grey them out without
   *  waiting for a re-run. */
  approved: string[];
  /** True while a capture is in flight. */
  running: boolean;
}

export interface RunProgress {
  running: boolean;
  done: number;
  total: number;
  storyId: string | null;
}

export type ImageKind = 'current' | 'baseline' | 'diff';

/**
 * Everything the HTTP layer needs, with no knowledge of how it is served.
 *
 * Splitting this out means the same implementation backs the standalone
 * `jux serve` and the middleware mounted inside a workbench's dev server —
 * and that a test can drive it without a socket.
 */
export interface ReviewSource {
  bundle(): Promise<ReviewBundle>;
  progress(): Promise<RunProgress>;
  image(kind: ImageKind, storyId: string): Promise<Buffer | null>;
  handoff(storyId: string): Promise<string | null>;
  approve(storyId: string): Promise<void>;
  /** Capture a subset, or everything when `storyIds` is omitted. */
  run(storyIds?: string[]): Promise<void>;
  cancel(): Promise<void>;
  stories(): Promise<StoryManifest[]>;
}
