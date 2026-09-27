import { afterEach, expect, it, vi } from 'vitest'

/** A fresh module per test: the blur watcher is installed once per module,
 *  on whichever `window` the first request sees. */
async function load(): Promise<typeof import('./FloatingPanelChrome.js')['raiseOnFrameFocus']> {
  vi.resetModules()
  return (await import('./FloatingPanelChrome.js')).raiseOnFrameFocus
}

/**
 * A click inside a floating window's iframe (a PDF, a report) never reaches
 * the board's document, so the window's own `pointerdown` raise cannot see
 * it. The board sees the focus move instead: the window blurs and the frame
 * becomes the active element. These stubs stand in for exactly that pair.
 */
class FakeIframe {}

function stubPage(): { blur: () => void; focusFrame: (f: FakeIframe | null) => void } {
  let onBlur: (() => void) | null = null
  const doc = { activeElement: null as unknown }
  vi.stubGlobal('HTMLIFrameElement', FakeIframe)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'blur') onBlur = fn
    },
    setTimeout: (fn: () => void) => fn(),
  })
  return {
    blur: () => onBlur?.(),
    focusFrame: (f) => {
      doc.activeElement = f
    },
  }
}

function fakePanel(frames: FakeIframe[]): HTMLElement {
  return {
    style: { zIndex: '' },
    contains: (node: unknown) => frames.includes(node as FakeIframe),
  } as unknown as HTMLElement
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('raises the window whose frame took focus, and only that window', async () => {
  const page = stubPage()
  const raiseOnFrameFocus = await load()
  const pdf = new FakeIframe()
  const viewer = fakePanel([pdf])
  const other = fakePanel([new FakeIframe()])
  const stopViewer = raiseOnFrameFocus(viewer)
  const stopOther = raiseOnFrameFocus(other)

  page.focusFrame(pdf)
  page.blur()
  expect(viewer.style.zIndex).not.toBe('')
  expect(other.style.zIndex).toBe('')

  stopViewer()
  stopOther()
})

it('ignores a blur that is not a frame taking focus, and a withdrawn window', async () => {
  const page = stubPage()
  const raiseOnFrameFocus = await load()
  const pdf = new FakeIframe()
  const viewer = fakePanel([pdf])
  const stop = raiseOnFrameFocus(viewer)

  // The whole browser window losing focus leaves no frame active.
  page.focusFrame(null)
  page.blur()
  expect(viewer.style.zIndex).toBe('')

  // The watcher is live: the frame taking focus does raise it...
  page.focusFrame(pdf)
  page.blur()
  const raised = viewer.style.zIndex
  expect(raised).not.toBe('')

  // ...until the window withdraws.
  stop()
  page.blur()
  expect(viewer.style.zIndex).toBe(raised)
})
