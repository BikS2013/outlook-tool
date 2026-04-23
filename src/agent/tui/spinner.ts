// src/agent/tui/spinner.ts

import { CLEAR_LINE } from "./ansi";
import type { SpinnerHandle } from "./types";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TICK_MS = 80;

/** Module-global lock: only one spinner can be active at a time. */
let _active: SpinnerHandle | null = null;

export function createSpinner(initialLabel: string): SpinnerHandle {
  let label = initialLabel;
  let idx = 0;
  let timer: NodeJS.Timeout | null = null;

  function render(): void {
    const frame = FRAMES[idx % FRAMES.length];
    // Write clear-line + frame + label, leaving cursor after label.
    process.stderr.write(`${CLEAR_LINE}${frame} ${label}`);
  }

  const handle: SpinnerHandle = {
    setLabel(s: string): void {
      label = s;
      if (timer !== null) render();
    },
    start(): void {
      if (_active !== null && _active !== handle) {
        _active.stop();
      }
      if (timer !== null) return;
      _active = handle;
      idx = 0;
      render();
      timer = setInterval(() => {
        idx = (idx + 1) % FRAMES.length;
        render();
      }, TICK_MS);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (_active === handle) {
        _active = null;
        process.stderr.write(CLEAR_LINE);
      }
    },
    isActive(): boolean {
      return timer !== null;
    },
  };

  return handle;
}

/** Test seam — exposed for unit tests that advance fake timers. */
export const SPINNER_FRAMES = FRAMES;
export const SPINNER_TICK_MS = TICK_MS;
