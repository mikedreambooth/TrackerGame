let locked = false;

/**
 * Stop the browser from turning finger drags into scrolling, pull-to-refresh,
 * swipe-back or pinch-zoom, so pointer events keep flowing to the simulator.
 *
 * CSS `touch-action: none` is enough in Chrome, but iOS Safari (especially
 * inside iframes) still starts its own gestures and then fires `pointercancel`,
 * which freezes the dragged hand. Cancelling `touchmove` is the reliable fix.
 * Taps (and so clicks on buttons/tiles) are unaffected.
 */
export function lockTouchGestures(): void {
  if (locked) return;
  locked = true;
  const s = document.documentElement.style;
  s.touchAction = 'none';
  s.overscrollBehavior = 'none';
  s.setProperty('-webkit-user-select', 'none');
  s.setProperty('user-select', 'none');
  s.setProperty('-webkit-touch-callout', 'none');
  s.setProperty('-webkit-tap-highlight-color', 'transparent');
  const block = (e: Event) => {
    if (e.cancelable) e.preventDefault();
  };
  document.addEventListener('touchmove', block, { passive: false });
  // iOS pinch-zoom gestures.
  document.addEventListener('gesturestart', block, { passive: false });
  document.addEventListener('gesturechange', block, { passive: false });
}
