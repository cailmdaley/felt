// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { mountChangeReader } from './ChangeReader.js'
import type { ChangeBundle } from './changeModel.js'
vi.mock('@pierre/diffs', () => ({ registerCustomCSSVariableTheme() {}, parsePatchFiles: () => [], FileDiff: class {} }))

it('keeps a review draft readable but disables sending when no worker exists', () => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const bundle: ChangeBundle = { version: 1, title: 'Review', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'a'.repeat(40), head: 'b'.repeat(40), base_ref: 'main', head_ref: 'topic', commits: [], files: [], story: null }
  const root = document.createElement('div'), send = vi.fn()
  const mounted = mountChangeReader(root, bundle, 'test', send, () => false)
  const field = root.querySelector('textarea')!
  field.value = 'Keep this note'; field.dispatchEvent(new Event('input'))
  const button = [...root.querySelectorAll('button')].find(button => button.textContent === 'Send review')!
  expect(button.disabled).toBe(true)
  expect(root.querySelector('[role="status"]')?.textContent).toContain('No live worker')
  button.click(); expect(send).not.toHaveBeenCalled()
  mounted.dispose(); vi.unstubAllGlobals()
})
