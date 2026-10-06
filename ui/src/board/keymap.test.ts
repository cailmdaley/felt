// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { DOCUMENT_KEY_INTENTS, keyIntent, shouldForwardDocumentKey, surfaceBindings, type KeySurface } from './keymap.js'

function event(key: string, init: KeyboardEventInit = {}, target?: HTMLElement): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target?.dispatchEvent(e)
  return e
}

describe('shared keyboard table', () => {
  it('every declared binding yields its intent on its surface, unshadowed by an earlier binding', () => {
    const misses: string[] = []
    for (const surface of ['desk', 'overview', 'reader'] as KeySurface[]) {
      for (const binding of surfaceBindings[surface]) {
        for (const key of binding.keys) {
          const label = `${surface}: ${binding.command ? 'Cmd+' : ''}${binding.alt ? 'Alt+' : ''}${key} → ${binding.intent}`
          const got = keyIntent(event(key === 'Shift+ ' ? ' ' : key, { altKey: binding.alt, metaKey: binding.command, shiftKey: key === 'Shift+ ' || /^[GJK?]$/.test(key) }), surface)
          if (got !== binding.intent) misses.push(`${label} (got ${got})`)
        }
      }
    }
    expect(misses).toEqual([])
  })
  it.each(['1', '2', '3', 'Tab'])('leaves chassis key %s alone', key => {
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
  it.each(['t', 'x', 'r', '.', 'z'])('guards action key %s against fields, IME, modifiers and repeat', key => {
    const input = document.createElement('textarea')
    expect(keyIntent(event(key, {}, input), 'reader')).toBeNull()
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { repeat: true }]) {
      expect(keyIntent(event(key, init), 'reader')).toBeNull()
    }
  })
  it('c opens the conversation (dot is its alias), s toggles the sidebar, and no report can ask for the conversation', () => {
    for (const surface of ['desk', 'reader'] as KeySurface[]) {
      expect(keyIntent(event('c'), surface)).toBe('conversation')
      expect(keyIntent(event('.'), surface)).toBe('conversation')
    }
    expect(keyIntent(event('s'), 'reader')).toBe('sidebar')
    expect(keyIntent(event('\\', { metaKey: true }), 'reader')).toBe('sidebar')
    expect(DOCUMENT_KEY_INTENTS).not.toContain('conversation')
  })
  it('reserves u for half-page up and dot for conversation on every reader page', () => {
    expect(keyIntent(event('u'), 'desk')).toBeNull()
    expect(keyIntent(event('u'), 'reader')).toBe('halfUp')
    expect(keyIntent(event('.'), 'reader')).toBe('conversation')
    expect(keyIntent(event(']'), 'reader')).toBe('audioForward')
    expect(keyIntent(event('['), 'reader')).toBe('audioBack')
    expect(keyIntent(event('p'), 'reader')).toBe('audioPlay')
    expect(keyIntent(event('>'), 'reader')).toBeNull()
    expect(keyIntent(event(','), 'reader')).toBeNull()
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
    for (const key of ['Enter', 'o', '?', 'Escape', '.']) expect(keyIntent(event(key, { repeat: true }), 'desk')).toBeNull()
  })
})
