// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsDialog } from './SettingsDialog'
import { useSettingsDraft } from './SettingsDraftContext'

const api = vi.hoisted(() => ({ index: vi.fn() }))
vi.mock('./settingsApi', async importOriginal => ({
  ...await importOriginal<object>(), loadConfigIndex: api.index,
}))
vi.mock('../AppDialog', () => ({ AppDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('./PathListSection', () => ({ PathListSection: ({ host }: { host: { label: string } }) => {
  const [dirty, setDirty] = useState(false)
  useSettingsDraft('mock-file', dirty, false)
  return <button onClick={() => setDirty(true)}>Edit paths on {host.label}</button>
} }))

let root: Root
const hosts = [
  { origin: '', label: 'local-host', isLocal: true, stale: false, host: 'local-host', hubHost: 'local-host', nativeFolderPicker: false, expandedFeltStores: [] },
  { origin: 'remote-host', label: 'remote-host', isLocal: false, stale: false, host: 'remote-host', hubHost: 'local-host', nativeFolderPicker: false, expandedFeltStores: [] },
]
const click = (text: string): void => {
  const button = [...document.querySelectorAll('button')].find(button => button.textContent === text)
  expect(button).toBeDefined()
  act(() => button!.click())
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  api.index.mockResolvedValue({ files: [] })
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<SettingsDialog shuttleBase="" hosts={hosts} onClose={vi.fn()} />))
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('opens on conversation preferences without a misleading host picker or host configuration read', () => {
  expect(document.querySelector('h2')?.textContent).toBe('Open conversations in')
  expect(document.querySelector('select')).toBeNull()
  expect(api.index).not.toHaveBeenCalled()
  expect(document.querySelector('[aria-current="page"]')?.textContent).toBe('Conversations')
  expect(document.body.textContent).toContain('Worker hosts')
})

it('keeps host editing addressed to the selected host and protects edits when returning to preferences', async () => {
  click('Notes & tasks')
  await act(async () => {})
  expect(api.index).toHaveBeenLastCalledWith('', hosts[0])
  const picker = document.querySelector<HTMLSelectElement>('select')!
  act(() => {
    picker.value = 'remote-host'
    picker.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})
  expect(api.index).toHaveBeenLastCalledWith('', hosts[1])
  click('Edit paths on remote-host')
  click('Conversations')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('unsaved edits on remote-host')
  expect(document.querySelector('h2')?.textContent).toBe('Notes & tasks')
  click('Keep editing')
  expect(document.querySelector('[role="alert"]')).toBeNull()
  click('Conversations')
  click('Discard edits')
  expect(document.querySelector('h2')?.textContent).toBe('Open conversations in')
  expect(document.querySelector('select')).toBeNull()
})

it('keeps Appearance in this browser: no host picker, no host read, saved locally and applied to the root', () => {
  click('Appearance')
  expect(document.querySelector('h2')?.textContent).toBe('Appearance')
  expect(document.querySelector('select')).toBeNull()
  expect(api.index).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('saved automatically in this browser')
  const radio = (name: string, value: string): HTMLInputElement => document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!
  expect(radio('appearance-mode', 'system').checked).toBe(true)
  expect(radio('appearance-dark', 'night-chart').checked).toBe(true)
  act(() => radio('appearance-dark', 'lamplight').click())
  act(() => radio('appearance-mode', 'light').click())
  expect(radio('appearance-mode', 'light').checked).toBe(true)
  expect(localStorage.setItem).toHaveBeenLastCalledWith('shuttle.appearance', JSON.stringify({ mode: 'light', dark: 'lamplight' }))
  expect(document.documentElement.dataset.wsAppearance).toBe('light')
})
