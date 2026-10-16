// The review API's contract.
//
// This is deliberately the stable surface, not the panel. A Storybook addon,
// a Ladle UI, an MCP server and a CLI all want the same operations; making
// HTTP the contract means each is a skin rather than a reimplementation.

import type { RunReport, StoryManifest } from '@juxtapose/core';

/** Latest attempted run, including failures before a report could be written.
 * Optional on responses for compatibility with older review servers. */
export interface ReviewRun {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
}

/** What the panel polls for. One request, everything it needs to render. */
export interface ReviewBundle {
  report: RunReport | null;
  /** Story ids approved since the run, so the UI can grey them out without
   *  waiting for a re-run. */
  approved: string[];
  /** True while a capture is in flight. */
  running: boolean;
  run?: ReviewRun;
}

export interface RunProgress {
  running: boolean;
  run?: ReviewRun;
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
  /** Refuses (UnstableCaptureError) a capture the run saw come out two ways
   *  unless `allowUnstable`. */
  approve(storyId: string, allowUnstable?: boolean): Promise<void>;
  /** Capture a subset, or everything when `storyIds` is omitted. */
  run(storyIds?: string[]): Promise<void>;
  cancel(): Promise<void>;
  stories(): Promise<StoryManifest[]>;
  /**
   * Which stories to recapture when `storyId` rerenders.
   *
   * Takes a story rather than a file list because that is what the workbench
   * can actually tell us: HMR rerenders a story, and the story knows its own
   * component path. Watching the filesystem would need a second source of
   * truth about which files matter.
   */
  affected(storyId: string): Promise<string[]>;
  /** Drop cached story metadata. The workbench signals when its index changed —
   *  cheaper and more correct than expiring on a timer. */
  flushIndex(): Promise<void>;
}
