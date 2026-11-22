/** The longest delay `setTimeout` accepts. Longer delays (and `Infinity`) overflow to about 1 ms in browsers and Node. */
export const MAX_TIMER_DELAY_MS = 2147483647;

/**
 * Clamps a timer delay into `[0, MAX_TIMER_DELAY_MS]`. `NaN` and negative
 * values become 0. Every timer the library sets goes through this.
 */
export function timerDelay(ms: number): number {
  if (!(ms > 0)) return 0;
  return ms > MAX_TIMER_DELAY_MS ? MAX_TIMER_DELAY_MS : ms;
}
