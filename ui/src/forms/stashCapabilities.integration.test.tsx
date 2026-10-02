// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StashForm } from './StashForm'
import type { Host, Project } from './projectModel'

it('rendered Stash hides and clears chrome on a headless scribe despite a capable agent', async () => {
  const hosts: Host[] = [
    { id: 'local', label: 'Desktop', isLocal: true, nativeFolderPicker: true, browserCapable: true },
    { id: 'remote', label: 'Headless', isLocal: false, nativeFolderPicker: false, browserCapable: false },
  ]
  const projects: Project[] = hosts.map((host) => ({
    id: `${host.id}:/work`, name: 'Work', path: '/work', originId: host.id, loomPrefix: '',
  }))
  const created = vi.fn()
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/agents') return { ok: true, json: async () => [{ id: 'claude-opus', default: true, chrome_capable: true }] }
    if (url === '/api/v1/fiber/create' && init?.method === 'POST') return { ok: true, json: async () => ({ id: 'test-constitution' }) }
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const chrome = () => document.querySelector<HTMLInputElement>('.form-chrome input')
  const selectHost = (id: string) => act(() => {
    const select = document.querySelector<HTMLSelectElement>('.form-select')!
    select.value = id
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  try {
    await act(async () => root.render(<StashForm hosts={hosts} projects={projects} onCreated={created} onCancel={vi.fn()} />))
    expect(document.querySelectorAll<HTMLSelectElement>('.form-select')[2]?.value).toBe('claude-opus')
    expect(chrome()).not.toBeNull()
    act(() => chrome()!.click())
    expect(chrome()!.checked).toBe(true)
    selectHost('remote')
    expect(document.querySelector('.form-chrome')).toBeNull()
    selectHost('local')
    expect(chrome()).not.toBeNull()
    expect(chrome()!.checked).toBe(false)
    act(() => chrome()!.click())
    selectHost('remote')
    expect(document.querySelector('.form-chrome')).toBeNull()
    act(() => {
      const title = document.querySelector<HTMLInputElement>('.stash-title')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Test constitution')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => document.querySelector<HTMLButtonElement>('.form-submit')!.click())
    const writes = fetcher.mock.calls.filter(([url]) => url === '/api/v1/fiber/create')
    expect(writes).toHaveLength(1)
    const body = JSON.parse(writes[0]![1]!.body as string)
    expect(body).toMatchObject({ origin: 'remote', frontmatter: { shuttle: { agent: 'claude-opus', project_dir: '/work' } } })
    expect(body.frontmatter.shuttle.chrome ?? false).toBe(false)
    expect(created).toHaveBeenCalledWith('test-constitution')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})
