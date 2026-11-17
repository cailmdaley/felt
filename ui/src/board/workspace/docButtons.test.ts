// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { card, settle } from '../testFixtures.js'
import type { MapFile } from '../family/model.js'
import { docButtons } from './docButtons.js'

afterEach(() => { document.body.replaceChildren() })

const file = (name: string, at: number): MapFile => ({ key: `host:/w/${name}`, name, at, unread: false })
const rows = (): string[] => [...document.querySelectorAll<HTMLElement>('.kbn-conversation-menu .uf-file-row')].map(row => row.dataset.key!)

it('keeps its count\'s button when the tapestry lands while the list hangs from it, and the list follows the files', async () => {
  let land: (lead: MapFile) => void = () => {}
  let sent = [file('plot.png', 2), file('tapestry.html', 1)]
  const pages = docButtons(card({ id: 'hub', uid: 'H' }), { lead: () => new Promise(resolve => { land = resolve }), files: () => sent, open: () => {} })
  document.body.append(pages.el)
  const count = pages.el.querySelector<HTMLButtonElement>('[data-part="sends"]')!
  expect(count.textContent).toBe('2')
  count.click(); await settle()
  expect(count.getAttribute('aria-expanded')).toBe('true')
  // The keys rest on the tapestry's row, which leaves the list when the tapestry lands.
  document.querySelectorAll<HTMLElement>('.kbn-conversation-menu [data-action-index]')[1].focus()
  const focused = (): string | null | undefined => document.activeElement?.querySelector('.uf-file-row')?.getAttribute('data-key')
  expect(focused()).toBe('host:/w/tapestry.html')
  land(file('tapestry.html', 1)); await settle()
  expect(focused()).toBe('host:/w/plot.png')
  // The tapestry stands on its own; the count is the same button, counting what is left.
  expect([pages.el.querySelector('[data-part="sends"]'), count.isConnected, count.textContent, rows()]).toStrictEqual([count, true, '1', ['host:/w/plot.png']])
  sent = [file('fit.png', 3), ...sent]
  pages.refresh()
  expect([count.textContent, rows()]).toStrictEqual(['2', ['host:/w/fit.png', 'host:/w/plot.png']])
})
