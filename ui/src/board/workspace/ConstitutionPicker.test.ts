// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ConstitutionPicker } from './ConstitutionPicker.js'

let picker: ConstitutionPicker | undefined
afterEach(() => { picker?.dispose(); document.body.replaceChildren() })

it('reports only retained, placed rows after every refresh and revision patch, then removes them once', () => {
  let cards = [card({ id: 'a', uid: 'a', name: 'Alpha' }), card({ id: 'b', uid: 'b', name: 'Beta' })]
  const faces: HTMLElement[] = []
  const onRow = vi.fn((el: HTMLElement) => expect(el.parentElement?.className).toBe('ws-channel-list'))
  const onRemove = vi.fn((el: HTMLElement) => expect(el.isConnected).toBe(false))
  picker = new ConstitutionPicker({ cards: () => cards, onOpen: vi.fn(), onRow, onRemove,
    renderCard: card => {
      const el = document.createElement('div')
      el.innerHTML = `<span class="ws-channel-name">${card.name}</span><small class="ws-channel-owner"></small>`
      faces.push(el)
      return el
    },
  })
  document.body.append(picker.el)
  picker.refresh(false)
  const [alpha, beta] = [...picker.el.querySelectorAll<HTMLElement>('.ws-channel-row')]
  expect(onRow.mock.calls.map(([el]) => el)).toEqual([alpha, beta])
  cards = [{ ...cards[0], name: 'Revised Alpha' }, cards[1]]
  picker.refresh(false)
  expect(onRow.mock.calls.map(([el]) => el)).toEqual([alpha, beta, alpha, beta])
  expect(alpha.textContent).toContain('Revised Alpha')
  expect(onRow).not.toHaveBeenCalledWith(faces[2], expect.anything())
  picker.find.value = 'Alpha'; picker.refresh(false)
  expect(onRemove).toHaveBeenCalledExactlyOnceWith(beta)
  picker.dispose()
  expect(onRemove.mock.calls.map(([el]) => el)).toEqual([beta, alpha])
  picker.dispose()
  expect(onRemove).toHaveBeenCalledTimes(2)
})
