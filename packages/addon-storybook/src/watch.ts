// Deciding when a story render means "the developer edited something".
//
// DOM-free on purpose: this is the part with the interesting logic, and the
// interesting logic should be testable without a Storybook channel or a
// browser. `manager.tsx` wires the events; this decides what they mean.

/** Wait for the render to settle before capturing. A save mid-keystroke can
 *  produce several renders, and the union of a burst is one capture. */
export const HMR_DEBOUNCE_MS = 500;

/**
 * Distinguishes an HMR rerender from a navigation render.
 *
 * There is no "story was hot-reloaded" event to listen for. What exists is:
 * `storyChanged` fires only when you navigate to a different story, and
 * `storyRendered` fires for both navigation and HMR. So a render is an edit
 * exactly when no navigation preceded it.
 *
 * Starts armed — the first render after the manager loads is the page opening,
 * not an edit, and recapturing on page load would make merely opening
 * Storybook kick off a run.
 */
export class RenderClassifier {
  private navigationPending = true;

  /** Storybook navigated to a different story. */
  navigated(): void {
    this.navigationPending = true;
  }

  /**
   * A story finished rendering. True when that was an edit rather than a
   * navigation, and so worth recapturing.
   */
  rendered(): boolean {
    if (this.navigationPending) {
      this.navigationPending = false;
      return false;
    }
    return true;
  }
}

/**
 * Collects story ids across a burst of renders and fires once.
 *
 * A burst is normal: saving a file that several open stories depend on
 * produces several renders in quick succession, and capturing each separately
 * would run the same work N times and leave the panel churning.
 */
export class CaptureBatch {
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flush: (storyIds: string[]) => void,
    private readonly delayMs: number = HMR_DEBOUNCE_MS,
  ) {}

  add(storyIds: string[]): void {
    for (const id of storyIds) this.pending.add(id);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.delayMs);
  }

  /** Drop anything pending without capturing — used on teardown so a timer
   *  cannot outlive the manager iframe. */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private fire(): void {
    this.timer = null;
    if (this.pending.size === 0) return;
    const ids = [...this.pending];
    this.pending.clear();
    this.flush(ids);
  }
}
