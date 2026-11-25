// The approval window's main button works only once it has been showing, with the window
// in front, for a moment with no press: a click meant for the page underneath can't land on
// it, nor can a stream of quick clicks begun there (run-3). A slower stream (one click a
// second, aimed where the window opens) could wait out the moment, so a mouse click counts
// only once the pointer has come onto the button after it armed (review-3); keys don't need
// that. And a pointer's click works only when its own press counted: one that went down
// before the button armed, and was held across a blur that cleared it, can't approve on
// release (run-5).

/** How long the button must show, with the window in front, before it works. */
export const ARM_MS = 800;

export type ArmEnv = {
  /** Whether the window is visible and focused. */
  front: () => boolean;
  /** Calls `f` on every focus, blur or visibility change; returns how to stop. */
  watch: (f: () => void) => () => void;
  /** Calls `f` after `ms`; returns how to cancel. */
  later: (f: () => void, ms: number) => () => void;
  /** Calls `down` on every pointer or key press in the window and `up` on its release, each
   *  with the pointer's or key's ID when known, and `mouse` true for a mouse's press;
   *  returns how to stop. */
  presses?: (down: (id?: string, mouse?: boolean) => void, up?: (id: string) => void) => () => void;
  /** Calls `f` each time a mouse pointer comes onto the button from outside it; returns how
   *  to stop. Without it, a mouse click needs no move onto the button. */
  enters?: (f: () => void) => () => void;
};

/** Disarms at once; while `showing`, arms ARM_MS after the window is in front, counted
 *  again each time it comes back to the front, and each time something is pressed before it
 *  arms, or a mouse is pressed after it armed without having come onto the button since.
 *  Returns how to stop. Called anew whenever the button appears, so a request whose review
 *  arrives late never shows it armed. */
export function arm(showing: boolean, env: ArmEnv, set: (armed: boolean) => void, pressed: (counted: boolean) => void = () => {}): () => void {
  set(false);
  // Whether the latest press counted: made with the button armed (and, for a mouse, after
  // coming onto it). A click from a press that didn't count is ignored by the button.
  pressed(false);
  if (!showing) return () => {};
  let armed = false;
  /** A mouse came onto the button since it armed. */
  let entered = false;
  let cancel = () => {};
  // Presses that went down before it armed and are still down: a click lands on release, so
  // it can't arm under one (run-4: a press held past ARM_MS approved on release).
  const held = new Set<string>();
  const check = () => {
    cancel();
    cancel = () => {};
    // Out of front, a press held from before no longer counts: its release may land elsewhere.
    if (!env.front()) held.clear();
    if (env.front() && held.size === 0) {
      cancel = env.later(() => {
        if (!armed) entered = false;
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
  // count again: only a press after a still moment counts. So does a mouse press after it
  // armed with the pointer where it was: a click stream aimed at the spot where the window
  // opens never moves onto the button, a user reaching for it does.
  const stopEnters =
    env.enters?.(() => {
      if (armed) entered = true;
    }) ?? (() => {});
  const stopPresses =
    env.presses?.(
      (id, mouse) => {
        const counts = armed && !(mouse === true && env.enters && !entered);
        pressed(counts);
        if (counts) return;
        if (id !== undefined) held.add(id);
        check();
      },
      (id) => {
        if (held.delete(id)) check();
      },
    ) ?? (() => {});
  return () => {
    cancel();
    stop();
    stopPresses();
    stopEnters();
  };
}
