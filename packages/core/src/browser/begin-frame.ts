// packages/core/src/browser/begin-frame.ts
//
// SPIKE (#145), off by default. Frame-controlled capture: Chrome is launched
// with --enable-begin-frame-control and --run-all-compositor-stages-before-draw,
// each target is created with enableBeginFrameControl, and nothing is drawn
// unless we send HeadlessExperimental.beginFrame. With
// run-all-compositor-stages-before-draw, one beginFrame runs the whole
// pipeline (rAF, style, layout, paint, commit, raster, activate, draw) before
// it returns, and the screenshot is read from that frame.
//
// rAF only fires when a frame is issued, so event-driven settle (idle.ts
// counts pending rAFs; waitForPaint and rerasterLayers wait on two of them)
// would never finish. A pump keeps issuing frames at a fixed interval for the
// life of the page; the screenshot pauses it and takes its own frame.
//
// Chrome refuses enableBeginFrameControl on macOS ("BeginFrameControl is not
// supported on MacOS yet", 151.0.7922.34), so this only runs on Linux/Windows.
//
// Environment:
//   JUX_BEGIN_FRAME=1              turn it on
//   JUX_BEGIN_FRAME_INTERVAL_MS=n  pump period (default 16; 0 = back to back)
//   JUX_SPIKE_PARTIAL_RASTER=1     drop --disable-partial-raster (#120 ablation)
//   JUX_SPIKE_NO_RERASTER=1        skip rerasterLayers (#136 ablation)
//   JUX_SPIKE_RUN_ALL_STAGES=1     only --run-all-compositor-stages-before-draw,
//                                  no frame control (runs on macOS)

import type { CdpConnection } from './cdp.js';

export const beginFrameEnabled = (): boolean => process.env.JUX_BEGIN_FRAME === '1';

export const BEGIN_FRAME_ARGS: readonly string[] = [
  '--enable-begin-frame-control',
  '--run-all-compositor-stages-before-draw',
];

const FRAME_SEND_TIMEOUT_MS = 5000;
const SCREENSHOT_ATTEMPTS = 5;

interface BeginFrameResult {
  hasDamage: boolean;
  screenshotData?: string;
}

/** Counters a measurement script can read off a page. */
export interface PumpStats {
  frames: number;
  damaged: number;
  errors: number;
  lastError?: string;
}

export class FramePump {
  readonly stats: PumpStats = { frames: 0, damaged: 0, errors: 0 };
  private running = true;
  private paused = 0;
  private inflight: Promise<unknown> = Promise.resolve();
  private wake: (() => void) | null = null;
  private readonly interval: number;

  constructor(
    private readonly connection: CdpConnection,
    private readonly sessionId: string,
    intervalMs = Number(process.env.JUX_BEGIN_FRAME_INTERVAL_MS ?? 16),
  ) {
    this.interval = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : 16;
    void this.loop();
  }

  private frame(screenshot: boolean): Promise<BeginFrameResult> {
    return this.connection.send<BeginFrameResult>(
      'HeadlessExperimental.beginFrame',
      {
        // The interval reported to the compositor; 60 Hz as an ordinary display.
        interval: 16.666,
        ...(screenshot ? { screenshot: { format: 'png' } } : {}),
      },
      this.sessionId,
      { timeout: FRAME_SEND_TIMEOUT_MS },
    );
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.paused === 0) {
        const p = this.frame(false).then(
          (r) => {
            this.stats.frames++;
            if (r.hasDamage) this.stats.damaged++;
          },
          (e: unknown) => {
            this.stats.errors++;
            this.stats.lastError = e instanceof Error ? e.message : String(e);
            // A closed session: stop rather than spin.
            if (/closed|detached|No session/i.test(this.stats.lastError))
              this.running = false;
          },
        );
        this.inflight = p;
        await p;
      }
      if (!this.running) break;
      await new Promise<void>((r) => {
        this.wake = r;
        const t = setTimeout(r, this.interval);
        t.unref();
      });
      this.wake = null;
    }
  }

  /** Pause the pump, let the frame in flight finish, and draw one frame with a screenshot. */
  async screenshot(): Promise<Buffer> {
    this.paused++;
    try {
      await this.inflight;
      for (let i = 0; i < SCREENSHOT_ATTEMPTS; i++) {
        const r = await this.frame(true);
        this.stats.frames++;
        if (r.hasDamage) this.stats.damaged++;
        if (r.screenshotData) return Buffer.from(r.screenshotData, 'base64');
      }
      throw new Error(
        `jux: HeadlessExperimental.beginFrame returned no screenshot in ${SCREENSHOT_ATTEMPTS} frames`,
      );
    } finally {
      this.paused--;
      this.wake?.();
    }
  }

  stop(): void {
    this.running = false;
    this.wake?.();
  }
}
