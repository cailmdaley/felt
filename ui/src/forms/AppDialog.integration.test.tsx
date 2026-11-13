// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AppDialog } from './AppDialog'
import { AddProjectPath } from './ProjectPicker'
import { blockingDialogOpen } from '../board/views/ViewRegistry'

let root: Root | undefined
async function mount(children: ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  function Example() {
    const [open, setOpen] = useState(true)
    return <AppDialog open={open} onOpenChange={setOpen} title="Edit task">{children}</AppDialog>
  }
  await act(async () => root!.render(<Example />))
  return document.querySelector<HTMLElement>('[role="dialog"]')!
}
function press(el: Element, key: string, shiftKey = false) {
  return act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })) })
}
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('names the modal, blocks board keys, traps Tab and closes on Escape', async () => {
  const dialog = await mount(<><input aria-label="Title" /><button>Cancel</button></>)
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Edit task')
  expect(blockingDialogOpen()).toBe(true)
  const input = dialog.querySelector('input')!
  const button = dialog.querySelector('button')!
  for (const el of [input, button]) vi.spyOn(el, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 30)] as unknown as DOMRectList)
  act(() => button.focus())
  await press(button, 'Tab')
  expect(document.activeElement).toBe(input)
  await press(input, 'Tab', true)
  expect(document.activeElement).toBe(button)
  await press(button, 'Escape')
  expect(blockingDialogOpen()).toBe(false)
})

it('leaves Escape to a field that spends it: the add-path row closes, the dialog stays', async () => {
  const cancel = vi.fn()
  const dialog = await mount(<AddProjectPath hostLabel="Desktop" busy={false} error={null} onSubmit={vi.fn()} onCancel={cancel} />)
  const input = dialog.querySelector('input')!
  act(() => input.focus())
  await press(input, 'Escape')
  expect(cancel).toHaveBeenCalledOnce()
  expect(blockingDialogOpen()).toBe(true)
})
