/**
 * Dismissing a thing is not the same as touching what is behind it.
 *
 * A tap that closes an overlay is ONE gesture with three events — `pointerdown`,
 * `pointerup`, and the `click` the browser synthesises from them. An overlay
 * that dismisses on `pointerdown` and removes its own scrim is gone by the time
 * the click is dispatched, so the click hits whatever the scrim was covering
 * and that thing opens. From the reader's side one tap did two things: put the
 * menu away and opened a card they never asked for. The rule this file exists
 * to enforce is the obvious one — **a dismiss consumes the whole gesture, and
 * nothing beneath the overlay receives any part of it.**
 *
 * Two shapes, because overlays come in two kinds:
 *
 *   - a surface with a SCRIM of its own (`dismissOnScrim`) — the scrim can eat
 *     every event itself, and does;
 *   - a surface that watches the DOCUMENT for a click-away (`suppressNextClick`)
 *     — it cannot eat the pointer events without breaking scrolling and
 *     dragging on the page underneath, so it lets those through and swallows
 *     only the click that would have activated something.
 *
 * Everything here takes its event target and its timers by injection, so the
 * rules are testable without a DOM (this repo has no jsdom).
 */

/** The slice of an event this file actually uses. Every member optional, so a
 *  real `Event` satisfies it and a three-line fake in a test does too. */
export interface GestureEvent {
  preventDefault?: () => void
  stopPropagation?: () => void
  stopImmediatePropagation?: () => void
}

/** The slice of `window`/`document`/an element that this file actually uses.
 *  Method shorthand, not a property with a function type: the bivariance it
 *  brings is what lets a real `Window` stand in for it. */
export interface GestureScope {
  addEventListener(type: string, fn: (e: GestureEvent) => void, opts?: unknown): void
  removeEventListener(type: string, fn: (e: GestureEvent) => void, opts?: unknown): void
}

export interface GestureTimers {
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}

/**
 * How long an armed click-swallow waits for its click before giving up.
 *
 * A click follows its pointerup within a frame or two on every engine; touch
 * adds the synthesised-click delay, historically up to ~350ms. A window
 * generous enough to cover that and no more is the whole art: too short and the
 * click gets through (the bug); too long and a *deliberate* second tap, made
 * after the overlay is gone, is eaten instead (the bug, wearing a hat).
 */
export const CLICK_SWALLOW_MS = 700

function cancel(e: GestureEvent): void {
  e.preventDefault?.()
  e.stopPropagation?.()
  e.stopImmediatePropagation?.()
}

/** The injected timers, or the real ones. */
function resolveTimers({ setTimer, clearTimer }: GestureTimers): Required<GestureTimers> {
  return {
    setTimer: setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number),
    clearTimer: clearTimer ?? ((id) => clearTimeout(id)),
  }
}

/**
 * Swallow the next click, if one arrives soon.
 *
 * Capture phase on the scope (normally `window`), so the suppression lands
 * before any handler on the element the click is aimed at — a bubbling listener
 * would run after the card's own `click` had already opened it.
 *
 * Returns a disarm function; arming twice is harmless, each arming swallows at
 * most one click.
 */
export function suppressNextClick(scope: GestureScope, timers: GestureTimers = {}): () => void {
  const { setTimer, clearTimer } = resolveTimers(timers)

  let done = false
  const onClick = (e: GestureEvent): void => {
    if (done) return
    cancel(e)
    stop()
  }
  const timer = setTimer(() => stop(), CLICK_SWALLOW_MS)

  function stop(): void {
    if (done) return
    done = true
    clearTimer(timer)
    scope.removeEventListener('click', onClick, true)
  }

  scope.addEventListener('click', onClick, true)
  return stop
}

/**
 * Wire a scrim so that tapping it dismisses its surface and nothing else.
 *
 * The scrim eats `pointerdown`, `pointerup` and `click` outright. `dismiss`
 * runs on pointerdown — a menu that lingered until the finger lifted would feel
 * stuck — and the click that the browser sends afterwards is swallowed at the
 * window, because by then the scrim has been removed from the DOM and the
 * click's target is whatever was underneath it.
 *
 * `scope` is where that one-shot suppression is armed: the window, in practice.
 */
export function dismissOnScrim(
  scrim: GestureScope,
  dismiss: () => void,
  scope: GestureScope,
  timers: GestureTimers = {},
): void {
  const swallow = (e: GestureEvent): void => cancel(e)
  scrim.addEventListener('pointerup', swallow)
  scrim.addEventListener('click', swallow)
  scrim.addEventListener('pointerdown', (e: GestureEvent) => {
    cancel(e)
    suppressNextClick(scope, timers)
    dismiss()
  })
}

/**
 * Run `fn` once the press that is currently down has been released.
 *
 * The long press fires WHILE THE FINGER IS STILL ON THE GLASS: the menu opens
 * under a pointer that has not lifted, and the `pointerup` that eventually
 * comes belongs to the gesture that opened the menu, not to a choice made in
 * it. Anything that would act on that pointerup has to wait for it to pass —
 * hence this. Call it when the menu opens; it fires on the first `pointerup`
 * or `pointercancel`, or immediately-ish if none comes (a keyboard-opened menu
 * has no press to wait for, so the timeout is the release).
 */
export function onPressRelease(
  scope: GestureScope,
  fn: () => void,
  timers: GestureTimers = {},
): () => void {
  const { setTimer, clearTimer } = resolveTimers(timers)

  let done = false
  const onEnd = (): void => {
    if (stop()) fn()
  }
  const timer = setTimer(onEnd, CLICK_SWALLOW_MS)

  /** Detach everything; true only the first time. */
  function stop(): boolean {
    if (done) return false
    done = true
    clearTimer(timer)
    scope.removeEventListener('pointerup', onEnd, true)
    scope.removeEventListener('pointercancel', onEnd, true)
    return true
  }

  scope.addEventListener('pointerup', onEnd, true)
  scope.addEventListener('pointercancel', onEnd, true)

  /** Teardown for the caller that closes before the finger ever lifts. */
  return () => void stop()
}

/**
 * Clear any text selection the OS made under a held finger.
 *
 * iPadOS answers a long press by selecting the nearest selectable run and
 * raising Copy/Look Up over it. The Desk opts out in CSS, but a surface mounted
 * on `document.body` is outside that subtree, and a selection made before the
 * surface existed survives it appearing.
 */
export function clearSelection(): void {
  globalThis.getSelection?.()?.removeAllRanges()
}
