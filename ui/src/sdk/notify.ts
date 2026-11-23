/**
 * Tell a page's callback something. What it throws is the page's own error:
 * it surfaces as an uncaught one and reaches neither the caller nor the
 * callbacks told after it, so it never reads as the daemon's answer.
 */
export function notify(tell: () => void): void {
  try { tell() } catch (error) {
    if (typeof reportError === 'function') reportError(error)
    else console.error(error)
  }
}
