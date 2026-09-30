import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FiberDetailModal } from './FiberDetailModal.js'
import type { Fiber } from './KanbanFiber.js'
import { dispatchFailureMessage, needsProjectDir, type DispatchFailureBody } from './KanbanModalShared.js'
import { inheritedProjectDir } from './KanbanReadModel.js'
import { buildProjectDirPrompt } from './projectDirPrompt.js'
import { card } from './testFixtures.js'

// ── A DOM just big enough for the prompt ─────────────────────────────────────
// No jsdom in this suite: elements hold children, text, a value, a disabled
// flag and their listeners, and `fire` plays an event through them.
class FakeEl {
  readonly tagName: string
  children: FakeEl[] = []
  className = ''
  type = ''
  placeholder = ''
  spellcheck = true
  value = ''
  disabled = false
  readonly style: Record<string, string> = {}
  readonly attrs: Record<string, string> = {}
  private readonly listeners: Record<string, ((e: unknown) => void)[]> = {}
  private ownText = ''

  constructor(tagName: string) {
    this.tagName = tagName
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('')
  }
  set textContent(value: string) {
    this.children = []
    this.ownText = value
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  fire(type: string, event: Record<string, unknown> = {}): void {
    const e = { preventDefault: () => {}, stopPropagation: () => {}, ...event }
    for (const fn of this.listeners[type] ?? []) fn(e)
  }
  append(...nodes: FakeEl[]): void {
    this.children.push(...nodes)
  }
  replaceChildren(...nodes: FakeEl[]): void {
    this.ownText = ''
    this.children = nodes
  }
  find(cls: string): FakeEl | undefined {
    for (const child of this.children) {
      if (child.className.split(' ').includes(cls)) return child
      const deeper = child.find(cls)
      if (deeper) return deeper
    }
    return undefined
  }
}

const el = (node: HTMLElement | FakeEl | undefined): FakeEl => {
  expect(node).toBeDefined()
  return node as unknown as FakeEl
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeEl(tag) })
})
afterEach(() => vi.unstubAllGlobals())

// The owner-host refusal that motivated this: a hand-written block, no project_dir.
const REASON =
  'cannot arm work/task: its shuttle: block has no project_dir ' +
  '(set it as you arm it: shuttle reopen work/task --project-dir <dir>)'
const refused: DispatchFailureBody = {
  reason: 'reopen_failed',
  host: 'owner-host',
  message: REASON,
  needs: 'project_dir',
}

describe('a refused reopen reads in the CLI’s own words', () => {
  it('places the reason on the host where any command it names must run', () => {
    expect(dispatchFailureMessage(refused, 'fallback')).toBe(`On owner-host: ${REASON}`)
  })

  it('carries the reason alone when the daemon names no host', () => {
    expect(dispatchFailureMessage({ reason: 'reopen_failed', message: REASON }, 'fallback')).toBe(REASON)
  })

  it('asks for a directory only when the refusal needs one', () => {
    expect(needsProjectDir(refused)).toBe(true)
    expect(needsProjectDir({ ...refused, needs: undefined })).toBe(false)
    expect(needsProjectDir({ reason: 'not_eligible', needs: 'project_dir' })).toBe(false)
  })
})

describe('inheritedProjectDir', () => {
  const fiber = (id: string, over: Partial<Fiber> = {}): Fiber =>
    ({ id, name: id, status: 'active', createdAt: '2026-01-01T00:00:00Z', ...over }) as Fiber
  const index = (...fibers: Fiber[]): Map<string, Fiber> => new Map(fibers.map((f) => [f.id, f]))

  it('takes the nearest ancestor on the same host', () => {
    const child = fiber('a/b/c', { shuttleHost: 'owner-host' })
    const byId = index(
      fiber('a', { shuttleHost: 'owner-host', shuttleProjectDir: '/srv/a' }),
      fiber('a/b', { shuttleHost: 'owner-host', shuttleProjectDir: '/srv/b' }),
      child,
    )
    expect(inheritedProjectDir(child, byId)).toEqual({ path: '/srv/b', from: 'a/b' })
  })

  it('walks past an ancestor on another host and one missing from the feed', () => {
    const child = fiber('a/b/c/d', { shuttleHost: 'owner-host' })
    const byId = index(
      fiber('a', { shuttleHost: 'owner-host', shuttleProjectDir: '/srv/a' }),
      fiber('a/b/c', { shuttleHost: 'laptop', shuttleProjectDir: '/Users/me/a' }),
      child,
    )
    expect(inheritedProjectDir(child, byId)).toEqual({ path: '/srv/a', from: 'a' })
  })

  it('suggests nothing for a fiber with its own directory or no owner', () => {
    const byId = index(fiber('a', { shuttleHost: 'owner-host', shuttleProjectDir: '/srv/a' }))
    expect(inheritedProjectDir(fiber('a/b', { shuttleHost: 'owner-host', shuttleProjectDir: '/x' }), byId))
      .toBeUndefined()
    expect(inheritedProjectDir(fiber('a/b'), byId)).toBeUndefined()
  })
})

describe('buildProjectDirPrompt', () => {
  it('shows the reason, prefills the ancestor’s directory and says where it came from', () => {
    const onStart = vi.fn()
    const prompt = el(buildProjectDirPrompt({
      reason: `On owner-host: ${REASON}`,
      host: 'owner-host',
      suggestion: { path: '/srv/checkout', from: 'work' },
      onStart,
    }))
    expect(el(prompt.find('kbn-start-prompt-reason')).textContent).toBe(`On owner-host: ${REASON}`)
    expect(el(prompt.find('kbn-start-prompt-label')).textContent).toBe('Project directory on owner-host')
    expect(el(prompt.find('kbn-start-prompt-input')).value).toBe('/srv/checkout')
    expect(el(prompt.find('kbn-start-prompt-hint')).textContent).toBe('Suggested from work.')
    // Nothing starts until the human presses Start.
    expect(onStart).not.toHaveBeenCalled()
    el(prompt.find('kbn-ctl-send')).fire('click')
    expect(onStart).toHaveBeenCalledWith('/srv/checkout')
  })

  it('waits for a directory when there is no suggestion, and trims what is typed', () => {
    const onStart = vi.fn()
    const prompt = el(buildProjectDirPrompt({ reason: REASON, onStart }))
    const input = el(prompt.find('kbn-start-prompt-input'))
    const start = el(prompt.find('kbn-ctl-send'))
    expect(prompt.find('kbn-start-prompt-hint')).toBeUndefined()
    expect(input.value).toBe('')
    expect(start.disabled).toBe(true)
    start.fire('click')
    expect(onStart).not.toHaveBeenCalled()

    input.value = '  ~/dev/work  '
    input.fire('input')
    expect(start.disabled).toBe(false)
    input.fire('keydown', { key: 'Enter' })
    expect(onStart).toHaveBeenCalledWith('~/dev/work')
  })
})

describe('the detail panel answers a refused start with the prompt', () => {
  it('renders the prompt in place of the error, then retries with the confirmed directory', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    const bodies: Record<string, unknown>[] = []
    const replies = [
      { status: 422, ok: false, json: async () => refused },
      { status: 200, ok: true, json: async () => ({ dispatched: true, tmux_session: 'worker' }) },
    ]
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      return replies.shift()
    }))
    const refreshed = vi.fn()
    const panel = new FiberDetailModal('http://daemon', refreshed)
    const close = vi.spyOn(panel, 'close').mockImplementation(() => {})
    const requeue = panel as unknown as {
      runRequeue: (c: ReturnType<typeof card>, directive: string, mode: 'fresh',
        btn: HTMLButtonElement, error: HTMLElement) => Promise<void>
    }
    const task = card({
      id: 'work/task',
      originId: 'owner-host',
      shuttleHost: 'owner-host',
      inheritedProjectDir: { path: '/srv/checkout', from: 'work' },
    })
    const btn = new FakeEl('button')
    btn.textContent = 'New session'
    const errorEl = new FakeEl('div')

    await requeue.runRequeue(task, 'go', 'fresh', btn as unknown as HTMLButtonElement,
      errorEl as unknown as HTMLElement)

    expect(close).not.toHaveBeenCalled()
    expect(errorEl.style.display).toBe('')
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toBe('New session')
    expect(errorEl.textContent).not.toContain('try again')
    expect(el(errorEl.find('kbn-start-prompt-reason')).textContent).toBe(`On owner-host: ${REASON}`)
    expect(el(errorEl.find('kbn-start-prompt-input')).value).toBe('/srv/checkout')
    expect(bodies[0]).not.toHaveProperty('project_dir')

    el(errorEl.find('kbn-ctl-send')).fire('click')
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(bodies[1]).toMatchObject({
      fiber_id: 'work/task',
      origin: 'owner-host',
      force: true,
      ad_hoc: true,
      resume_mode: 'fresh',
      user_message: 'go',
      project_dir: '/srv/checkout',
    })
    expect(refreshed).toHaveBeenCalledOnce()
  })

  it('shows any other refused reopen as its reason, with no prompt', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    const other: DispatchFailureBody = {
      reason: 'reopen_failed',
      host: 'owner-host',
      message: 'cannot arm: agent claude-retired is not in the registry (shuttle set-agent to pick a current one)',
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 422, ok: false, json: async () => other })))
    const panel = new FiberDetailModal('http://daemon', vi.fn())
    const requeue = panel as unknown as {
      runRequeue: (c: ReturnType<typeof card>, directive: string, mode: 'fresh',
        btn: HTMLButtonElement, error: HTMLElement) => Promise<void>
    }
    const errorEl = new FakeEl('div')
    await requeue.runRequeue(card({ id: 'work/task' }), '', 'fresh',
      new FakeEl('button') as unknown as HTMLButtonElement, errorEl as unknown as HTMLElement)
    expect(errorEl.find('kbn-start-prompt')).toBeUndefined()
    expect(errorEl.textContent).toBe(`On owner-host: ${other.message}`)
  })
})
