import { afterEach, expect, it, vi } from 'vitest'

class FakeStyle {
  cssText = ''
  values = new Map<string, string>()

  setProperty(name: string, value: string): void {
    this.values.set(name, value)
  }

  removeProperty(name: string): void {
    this.values.delete(name)
  }
}

class FakeElement {
  className = ''
  readonly style = new FakeStyle()
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Array<() => void>>()
  parentElement: FakeElement | null = null
  hidden = false
  title = ''
  textContent = ''
  type = ''
  src = ''
  srcdoc = ''
  scrollTop = 0
  scrollLeft = 0
  offsetLeft = 0
  offsetTop = 0
  offsetWidth = 0
  offsetHeight = 0
  clientWidth = 0
  clientHeight = 0

  readonly classList = {
    add: (...names: string[]) => this.setClasses([...this.classes(), ...names]),
    remove: (...names: string[]) => this.setClasses(this.classes().filter((name) => !names.includes(name))),
    contains: (name: string) => this.classes().includes(name),
    toggle: (name: string, force?: boolean) => {
      const classes = this.classes()
      const has = classes.includes(name)
      const add = force ?? !has
      if (add && !has) this.setClasses([...classes, name])
      if (!add && has) this.setClasses(classes.filter((item) => item !== name))
      return add
    },
  }

  readonly tagName: string

  constructor(tagName: string) {
    this.tagName = tagName
  }

  get isConnected(): boolean {
    return this.parentElement !== null
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove()
      node.parentElement = this
      this.children.push(node)
    }
  }

  insertBefore(node: FakeElement, before: FakeElement | null): void {
    node.remove()
    node.parentElement = this
    const index = before ? this.children.indexOf(before) : -1
    this.children.splice(index < 0 ? this.children.length : index, 0, node)
  }

  remove(): void {
    if (!this.parentElement) return
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    if (index >= 0) siblings.splice(index, 1)
    this.parentElement = null
  }

  replaceWith(node: FakeElement): void {
    const parent = this.parentElement
    if (!parent) return
    const index = parent.children.indexOf(this)
    node.remove()
    node.parentElement = parent
    parent.children[index] = node
    this.parentElement = null
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  click(): void {
    for (const listener of this.listeners.get('click') ?? []) listener()
  }

  querySelector<T extends HTMLElement = HTMLElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null
  }

  querySelectorAll<T extends HTMLElement = HTMLElement>(selector: string): T[] {
    const [tag, className] = selectorParts(selector)
    return this.children.flatMap((child) => {
      const matchTag = !tag || child.tagName.toLowerCase() === tag
      const matchClass = !className || child.classes().includes(className)
      return [
        ...(matchTag && matchClass ? [child as unknown as T] : []),
        ...child.querySelectorAll<T>(selector),
      ]
    })
  }

  private classes(): string[] {
    return this.className.split(/\s+/).filter(Boolean)
  }

  private setClasses(classes: string[]): void {
    this.className = [...new Set(classes)].join(' ')
  }
}

function selectorParts(selector: string): [string, string] {
  const match = selector.match(/^(\w+)?(?:\.([\w-]+))?$/)
  return [match?.[1]?.toLowerCase() ?? '', match?.[2] ?? '']
}

const storage = new Map<string, string>()
const localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
}
const body = new FakeElement('body')
const fakeDocument = {
  body,
  baseURI: 'http://localhost/',
  hidden: false,
  createElement: (tag: string) => new FakeElement(tag) as unknown as HTMLElement,
  addEventListener: () => {},
  removeEventListener: () => {},
}
const fakeWindow = {
  innerWidth: 1440,
  innerHeight: 900,
  localStorage,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
  clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
}

let destroyReader: (() => void) | null = null

afterEach(() => {
  destroyReader?.()
  destroyReader = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
  storage.clear()
  body.children.splice(0)
})

it('polls only the active reader tab and revalidates it when reactivated', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('HTMLImageElement', class HTMLImageElement {})

  const requests: Array<{ path: string | null; headers: Headers }> = []
  const reads = new Map<string, number>()
  const fetchFile = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), fakeDocument.baseURI)
    const path = url.searchParams.get('path') ?? ''
    const headers = new Headers(init?.headers)
    requests.push({ path, headers })
    const count = (reads.get(path) ?? 0) + 1
    reads.set(path, count)
    const etag = `"${path}"`

    if (count > 1 && headers.has('if-none-match')) {
      return new Response(null, { status: 304, headers: { etag } })
    }
    const body = path.endsWith('/a.html') && count > 1 ? '<p>A refreshed</p>' : `<p>${path}</p>`
    return new Response(body, { status: 200, headers: { etag } })
  })
  vi.stubGlobal('fetch', fetchFile)
  vi.resetModules()

  const { ShelfReader } = await import('./views/ShelfReader.js')
  const reader = new ShelfReader(() => '', () => null)
  destroyReader = () => reader.destroy()
  reader.open({ fullPath: '/work/a.html', basename: 'a.html', timestamp: 1 })
  await flushPromises()

  const cells = body.querySelectorAll('.kbn-detail-view-cell') as unknown as FakeElement[]
  const tabs = body.querySelectorAll('.kbn-detail-tab') as unknown as FakeElement[]
  const cellA = cells[0]
  const viewerA = cellA.children[0]
  cellA.scrollTop = 321

  reader.open({ fullPath: '/work/b.html', basename: 'b.html', timestamp: 2 })
  await flushPromises()
  expect(fetchFile).toHaveBeenCalledTimes(2)

  await vi.advanceTimersByTimeAsync(4_000)
  expect(requests.slice(2).map((request) => request.path)).toEqual(['/work/b.html'])
  expect(cellA.children[0]).toBe(viewerA)
  expect(cellA.scrollTop).toBe(321)

  const tabA = tabs.find((tab) => tab.title === '/work/a.html')
  expect(tabA).toBeDefined()
  tabA!.click()
  await flushPromises()

  expect(requests.slice(3).map((request) => request.path)).toEqual(['/work/a.html'])
  expect(requests[3].headers.has('if-none-match')).toBe(false)
  expect(cellA.children[0]).toBe(viewerA)
  expect(cellA.scrollTop).toBe(321)
})

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}
