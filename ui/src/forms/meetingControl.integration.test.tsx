// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeetingControl } from './CaptureForm'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('rendered MeetingControl', () => {
  it('toggles intent on and off without a mode picker', () => {
    const change = vi.fn()
    for (const enabled of [false, true]) {
      act(() => root.render(<MeetingControl enabled={enabled} disabled={false} onChange={change} />))
      expect(container.querySelectorAll('button')).toHaveLength(1)
      expect(container.querySelector('[role="radiogroup"]')).toBeNull()
      act(() => container.querySelector<HTMLButtonElement>('button')!.click())
      expect(change).toHaveBeenLastCalledWith(!enabled)
    }
  })

  it('cannot enable a disabled meeting', () => {
    const change = vi.fn()
    act(() => root.render(<MeetingControl enabled={false} disabled onChange={change} />))
    const button = container.querySelector<HTMLButtonElement>('button')!
    expect(button.disabled).toBe(true)
    act(() => button.click())
    expect(change).not.toHaveBeenCalled()
  })
})
