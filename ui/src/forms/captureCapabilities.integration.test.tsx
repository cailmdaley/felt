// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CaptureForm } from './CaptureForm'
import { MOBILE_MEDIA } from '../board/mobile'
import type { Host, Project } from './projectModel'

const base = 'https://capture.example'
const hosts: Host[] = [
  { id: 'local', label: 'Local', isLocal: true, nativeFolderPicker: true, browserCapable: true },
  { id: 'remote', label: 'Remote', isLocal: false, nativeFolderPicker: false, browserCapable: false },
]
const projects: Project[] = hosts.map(host => ({ id: `${host.id}:/work`, name: 'Work', path: '/work', originId: host.id, loomPrefix: '' }))
const agents = [{ id: 'claude-opus', default: true, chrome_capable: true }, { id: 'claude-sonnet', default: false, chrome_capable: false }]
let root: Root
let mobile = false
const spawned = vi.fn()
const fetcher = vi.fn()
const tick = async () => { await act(async () => { await Promise.resolve() }) }
const click = (selector: string) => act(() => document.querySelector<HTMLButtonElement>(selector)!.click())
const select = (index: number, value: string) => act(() => {
  const element = document.querySelectorAll<HTMLSelectElement>('.form-select')[index]!
  element.value = value; element.dispatchEvent(new Event('change', { bubbles: true }))
})
const yap = () => act(() => {
  const element = document.querySelector<HTMLTextAreaElement>('textarea')!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, 'A thought')
  element.dispatchEvent(new Event('input', { bubbles: true }))
})
async function mount(choices = hosts) {
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<CaptureForm projects={projects} hosts={choices} shuttleBase={base} onSpawned={spawned} onCancel={vi.fn()} />))
  await tick()
}
const captureBody = () => JSON.parse(fetcher.mock.calls.find(([url]) => url.endsWith('/capture'))![1].body)
beforeEach(() => {
  mobile = false
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: mobile && query === MOBILE_MEDIA }))
  fetcher.mockImplementation(async (url: string) => Response.json(url.endsWith('/agents') ? agents : { spawned: true, tmux_session: 'capture-worker' }))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)) })
  document.body.replaceChildren(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it.each([false, true])('captures a note without requesting any audio (phone=%s)', async phone => {
  mobile = phone
  await mount()
  expect(document.querySelector('[aria-pressed]')).toBeNull()
  expect(document.querySelector('select[aria-label="Language"]')).toBeNull()
  expect(document.querySelector<HTMLButtonElement>('.form-submit')!.disabled).toBe(true)
  yap(); click('.form-submit'); await tick()
  expect(captureBody()).toMatchObject({ prompt: 'A thought', origin: 'local', project_dir: '/work' })
  expect(Object.keys(captureBody()).sort()).toEqual(['agent', 'origin', 'project_dir', 'prompt'])
  expect(fetcher.mock.calls.every(([url]) => /\/(agents|capture)$/.test(url))).toBe(true)
  expect(spawned).toHaveBeenCalledWith({ tmuxSession: 'capture-worker' })
})
it('reports HTTP errors even when the response is not JSON', async () => {
  await mount(); yap()
  fetcher.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <') } })
  click('.form-submit'); await tick()
  expect(document.querySelector('.form-error')!.textContent).toContain('Capture failed (502)')
})
it('offers chrome on a browser-capable remote', async () => {
  await mount(hosts.map(host => ({ ...host, browserCapable: !host.isLocal })))
  expect(document.querySelector('.form-chrome')).toBeNull()
  select(0, 'remote'); click('.form-chrome input'); yap(); click('.form-submit'); await tick()
  expect(captureBody()).toMatchObject({ origin: 'remote', chrome: true })
})
it.each(['headless host', 'unsupported agent'])('clears chrome when switching to an %s', async destination => {
  await mount(); click('.form-chrome input')
  const away = () => destination === 'headless host' ? select(0, 'remote') : select(2, 'claude-sonnet')
  const back = () => destination === 'headless host' ? select(0, 'local') : select(2, 'claude-opus')
  away(); expect(document.querySelector('.form-chrome')).toBeNull()
  back(); expect(document.querySelector<HTMLInputElement>('.form-chrome input')!.checked).toBe(false)
  click('.form-chrome input'); away(); yap(); click('.form-submit'); await tick()
  expect(captureBody().chrome ?? false).toBe(false)
  expect(captureBody()).toMatchObject(destination === 'headless host' ? { origin: 'remote' } : { agent: 'claude-sonnet' })
  expect(spawned).toHaveBeenCalledOnce()
})
