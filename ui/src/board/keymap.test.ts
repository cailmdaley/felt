// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { keyIntent, shouldForwardDocumentKey, surfaceBindings, type KeySurface } from './keymap.js'

function event(key: string, init: KeyboardEventInit = {}, target?: HTMLElement): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target?.dispatchEvent(e)
  return e
}

describe('shared keyboard table', () => {
  for (const surface of ['desk', 'overview', 'reader'] as KeySurface[]) {
    for (const binding of surfaceBindings[surface]) {
      for (const key of binding.keys) {
        it(`${surface}: ${binding.command ? 'Cmd+' : ''}${binding.alt ? 'Alt+' : ''}${key} → ${binding.intent}`, () => {
          expect(keyIntent(event(key === 'Shift+ ' ? ' ' : key, { altKey: binding.alt, metaKey: binding.command, shiftKey: key === 'Shift+ ' || /^[GJK?]$/.test(key) }), surface)).toBe(binding.intent)
        })
      }
    }
  }
  it.each(['1', '2', '3', ',', 'Tab'])('leaves chassis key %s alone', key => {
    for (const surface of ['desk', 'overview', 'reader'] as KeySurface[]) expect(keyIntent(event(key), surface)).toBeNull()
  })
  it.each(['input', 'textarea', 'select'])('ignores typing in %s, including reader Alt-arrows', tag => {
    const field = document.createElement(tag)
    expect(keyIntent(event('j', {}, field), 'desk')).toBeNull()
    for (const surface of ['desk', 'overview', 'reader'] as KeySurface[]) expect(keyIntent(event('/', {}, field), surface)).toBeNull()
    expect(shouldForwardDocumentKey(event('/', {}, field))).toBe(false)
    expect(keyIntent(event('ArrowRight', { altKey: true }, field), 'reader')).toBeNull()
    expect(shouldForwardDocumentKey(event('ArrowRight', { altKey: true }, field))).toBe(false)
  })
  it('guards nested contenteditable nodes and non-editable islands', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const child = document.createElement('span')
    editable.append(child)
    expect(keyIntent(event('j', {}, child), 'reader')).toBeNull()
    expect(shouldForwardDocumentKey(event('j', {}, child))).toBe(false)
    expect(keyIntent(event('ArrowDown', { altKey: true }, child), 'reader')).toBeNull()
    child.setAttribute('contenteditable', 'false')
    expect(keyIntent(event('j', {}, child), 'reader')).toBe('nextChannel')
    expect(keyIntent(event('ArrowDown', { altKey: true }, child), 'reader')).toBe('nextChannel')
  })
  it('gives native activation and composite navigation controls first refusal', () => {
    const button = document.createElement('button')
    for (const key of ['Enter', ' ']) expect(shouldForwardDocumentKey(event(key, {}, button))).toBe(false)

    const radioGroup = document.createElement('div')
    radioGroup.setAttribute('role', 'radiogroup')
    const radio = document.createElement('div')
    radio.setAttribute('role', 'radio')
    radioGroup.append(radio)
    expect(shouldForwardDocumentKey(event('ArrowRight', {}, radio))).toBe(false)
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const menuItem = document.createElement('div')
    menuItem.setAttribute('role', 'menuitem')
    menu.append(menuItem)
    expect(shouldForwardDocumentKey(event('ArrowDown', {}, menuItem))).toBe(false)

    const input = document.createElement('input')
    input.setAttribute('contenteditable', 'false')
    expect(keyIntent(event('j', {}, input), 'reader')).toBeNull()
    expect(shouldForwardDocumentKey(event('j', {}, input))).toBe(false)
  })
  it('recognizes editable targets from another document realm', () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const frameDocument = frame.contentDocument!
    const editable = frameDocument.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const child = frameDocument.createElement('span')
    editable.append(child)
    const key = event('j', {}, child)
    expect(keyIntent(key, 'desk')).toBeNull()
    expect(shouldForwardDocumentKey(key)).toBe(false)
    frame.remove()
  })
  it.each([{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { ctrlKey: true }, { altKey: true }])('ignores composing/modifier bare keys %j', init => {
    expect(keyIntent(event('j', init), 'desk')).toBeNull()
  })
  it('gives document handlers first refusal', () => {
    const e = event('j')
    e.preventDefault()
    expect(keyIntent(e, 'desk')).toBeNull()
    expect(shouldForwardDocumentKey(e)).toBe(false)
    expect(shouldForwardDocumentKey(event('j'))).toBe(true)
    for (const key of ['c', '/']) {
      const handled = event(key)
      handled.preventDefault()
      expect(keyIntent(handled, 'reader')).toBeNull()
      expect(shouldForwardDocumentKey(handled)).toBe(false)
    }
  })
  it('allows held movement, not repeated activation or dismissal', () => {
    expect(keyIntent(event('j', { repeat: true }), 'desk')).toBe('down')
    for (const key of ['Enter', 'o', '?', 'Escape', 'u']) expect(keyIntent(event(key, { repeat: true }), 'desk')).toBeNull()
  })
})
