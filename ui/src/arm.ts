// The approval window's main button works only once it has been showing, with the window
// in front, for a moment with no press: a click meant for the page underneath can't land on
// it, nor can a stream of clicks begun there (run-3).

/** How long the button must show, with the window in front, before it works. */
export const ARM_MS = 800;

export type ArmEnv = {
  /** Whether the window is visible and focused. */
  front: () => boolean;
  /** Calls `f` on every focus, blur or visibility change; returns how to stop. */
  watch: (f: () => void) => () => void;
  /** Calls `f` after `ms`; returns how to cancel. */
  later: (f: () => void, ms: number) => () => void;
  /** Calls `f` on every pointer or key press in the window; returns how to stop. */
  presses?: (f: () => void) => () => void;
};

/** Disarms at once; while `showing`, arms ARM_MS after the window is in front, counted
 *  again each time it comes back to the front, and each time something is pressed before it
 *  arms. Returns how to stop. Called anew whenever the button appears, so a request whose
 *  review arrives late never shows it armed. */
export function arm(showing: boolean, env: ArmEnv, set: (armed: boolean) => void): () => void {
  set(false);
  if (!showing) return () => {};
  let armed = false;
  let cancel = () => {};
  const check = () => {
    cancel();
    cancel = () => {};
    if (env.front()) {
      cancel = env.later(() => {
        armed = true;
        set(true);
      }, ARM_MS);
    } else {
      armed = false;
      set(false);
    }
  };
  check();
  const stop = env.watch(check);
  // A press before it arms (one that started on the page, or a stream of them) starts the
  // count again: only a press after a still moment counts.
  const stopPresses = env.presses?.(() => {
    if (!armed) check();
  }) ?? (() => {});
  return () => {
    cancel();
    stop();
    stopPresses();
  };
}
