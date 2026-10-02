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

describe('rendered MeetingControl capabilities', () => {
  it('singleton toggle chooses the offered mode rather than an unsupported default', () => {
    const change = vi.fn()
    act(() => root.render(<MeetingControl enabled={false} mode={null} modes={['phone']} disabled={false} onChange={change} />))
    expect(container.querySelector('[role="radiogroup"]')).toBeNull()
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(change).toHaveBeenLastCalledWith('phone')
    act(() => root.render(<MeetingControl enabled mode="phone" modes={['phone']} disabled={false} onChange={change} />))
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(change).toHaveBeenLastCalledWith(null)
  })

  it('renders only offered segments, preserves the default, and disables every interaction', () => {
    const change = vi.fn()
    act(() => root.render(<MeetingControl enabled={false} mode={null} modes={['room', 'phone']} defaultMode="phone" disabled={false} onChange={change} />))
    expect([...container.querySelectorAll('[role="radio"]')].map((node) => node.textContent)).toEqual(['Room', 'Phone'])
    expect(container.querySelector('[role="radiogroup"]')?.hasAttribute('hidden')).toBe(true)
    act(() => container.querySelector<HTMLButtonElement>('.capture-meeting-toggle')!.click())
    expect(change).toHaveBeenLastCalledWith('phone')
    act(() => root.render(<MeetingControl enabled mode="phone" modes={['room', 'phone']} disabled={false} onChange={change} />))
    act(() => container.querySelector<HTMLButtonElement>('[role="radio"]')!.click())
    expect(change).toHaveBeenLastCalledWith('room')
    act(() => root.render(<MeetingControl enabled mode="phone" modes={['room', 'phone']} disabled onChange={change} />))
    change.mockClear()
    for (const button of container.querySelectorAll<HTMLButtonElement>('button')) {
      expect(button.disabled).toBe(true)
      act(() => button.click())
    }
    expect(change).not.toHaveBeenCalled()
  })
})
