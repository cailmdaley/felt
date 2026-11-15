import { createChange, createReorder, definePrimitive, type ReorderDraft } from '@ui-sdk/core'
import { attachLongPress } from './longPress.js'

interface RailState { value: string[]; moving: ReorderDraft | null }
interface RailOptions { value?: string[]; onValueChange?: (value: string[]) => void }

/** The rail's order as UI SDK reorders it: a fixed item (one waiting on the human) is never picked up. */
const railPrimitive = definePrimitive({
  name: 'kbn-ch-rail',
  options: { value: 'value', onValueChange: 'callback' },
  state: (options: RailOptions): RailState => ({ value: options.value ?? [], moving: null }),
  sync: options => options.value === undefined ? {} : { value: options.value },
  api: context => {
    const change = createChange(context)
    return {
      reorder: createReorder<RailState, { fixed: boolean }>(context, {
        slot: 'item', key: 'value', draft: 'moving',
        set: (value, details) => change('value', value, details),
        disabled: item => item.props.fixed,
        // A copy follows the pointer and a drag near the rail's edge scrolls it; the item marks where it would land.
        preview: true,
      }),
    }
  },
  slots: slot => ({ item: slot({}) }),
})

export interface RailReorder {
  /** The keys the rail shows, in its order. */
  set(keys: readonly string[]): void
  /** Whether an entry is pressed or picked up, so the rail must not be rebuilt. */
  readonly moving: boolean
  /**
   * Makes a rail entry movable: a mouse drags it, a finger holds it still and
   * then drags it, and Alt+↑ / Alt+↓ move it one place. A hold lifted without
   * dragging, a right-click and the context-menu key ask for its menu.
   */
  attach(pick: HTMLElement, key: string, fixed: boolean): () => void
  destroy(): void
}

/**
 * The rail's reordering. `onOrder` hears the keys in their new order when a
 * move lands; `onMenu` asks for an entry's menu, at a point when a pointer
 * asked; `onSettled` hears that a move has ended, landed or not.
 */
export function createRailReorder(on: {
  onOrder: (keys: string[]) => void
  onMenu: (key: string, pick: HTMLElement, point?: { x: number; y: number }) => void
  onSettled: () => void
}): RailReorder {
  const id = `kbn-ch-rail-${Math.random().toString(36).slice(2)}`
  const rail = railPrimitive({ id, value: [], onValueChange: on.onOrder })
  const { reorder } = rail.api as { reorder: ReturnType<typeof createReorder<RailState>> }
  const picks = new Map<string, HTMLElement>()
  const state = (): RailState => rail.get() as RailState
  let keys: readonly string[] = []
  let was = false
  /** The item last picked up, so a hold that turned into a drag does not also ask for the menu. */
  let picked: string | null = null
  /** A pointer is down on an entry: nothing is rebuilt under it until it lifts. */
  let pressed = false
  // The draft's order is drawn with CSS `order`, so nothing is rebuilt under a moving item.
  const unsubscribe = rail.subscribe(() => {
    const now = state(), order = reorder.order(now)
    for (const [key, pick] of picks) {
      pick.parentElement!.style.order = String(order.indexOf(key))
      pick.toggleAttribute('data-moving', reorder.moving(now, key))
    }
    if (now.moving) picked = now.moving.key
    if (was && !now.moving) on.onSettled()
    was = !!now.moving
  })
  return {
    set(next) {
      keys = next
      rail.setOptions({ id, value: [...next], onValueChange: on.onOrder })
    },
    get moving() { return pressed || !!state().moving },
    attach(pick, key, fixed) {
      picks.set(key, pick)
      const unbind = reorder.bind(pick, { key, props: { fixed } })
      let down: PointerEvent | null = null
      let armed = false
      const menu = (point?: { x: number; y: number }): void => on.onMenu(key, pick, point)
      const finish = (): void => {
        window.removeEventListener('pointerup', lift)
        window.removeEventListener('pointercancel', finish)
        armed = pressed = false
        on.onSettled()
      }
      // A hold lifted without becoming a drag asks for the menu.
      const lift = (): void => {
        const ask = armed && picked !== key
        finish()
        if (ask) menu()
      }
      const pointerdown = (event: PointerEvent): void => {
        if (!event.isPrimary) return
        down = event
        pressed = true
        window.addEventListener('pointerup', lift)
        window.addEventListener('pointercancel', finish)
        if (event.pointerType === 'mouse') reorder.pointerdown(event, key)
      }
      // A finger that held still is picked up from where it first pressed.
      const stopHold = attachLongPress(pick, {
        onFire: () => {
          if (!down) return
          armed = true
          picked = null
          if (!fixed) reorder.pointerdown(down, key)
        },
      })
      // Once held, the finger moves the item rather than scrolling the rail.
      const touchmove = (event: TouchEvent): void => { if (armed) event.preventDefault() }
      const contextmenu = (event: MouseEvent): void => {
        event.preventDefault()
        if (pick.getAttribute('aria-expanded') === 'true' || armed) return
        menu(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined)
      }
      const keydown = (event: KeyboardEvent): void => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); event.stopPropagation()
          menu()
          return
        }
        if (!event.altKey || fixed || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
        event.preventDefault(); event.stopPropagation()
        const to = keys.indexOf(key) + (event.key === 'ArrowUp' ? -1 : 1)
        // Nothing moves above what waits on the human.
        if (to >= 0 && !picks.get(keys[to])?.hasAttribute('data-fixed')) reorder.move(key, to)
      }
      pick.toggleAttribute('data-fixed', fixed)
      pick.addEventListener('pointerdown', pointerdown)
      pick.addEventListener('touchmove', touchmove, { passive: false })
      pick.addEventListener('contextmenu', contextmenu)
      pick.addEventListener('keydown', keydown)
      return () => {
        if (picks.get(key) === pick) picks.delete(key)
        window.removeEventListener('pointerup', lift)
        window.removeEventListener('pointercancel', finish)
        unbind(); stopHold()
        pick.removeEventListener('pointerdown', pointerdown)
        pick.removeEventListener('touchmove', touchmove)
        pick.removeEventListener('contextmenu', contextmenu)
        pick.removeEventListener('keydown', keydown)
      }
    },
    destroy() { unsubscribe(); rail.destroy() },
  }
}
