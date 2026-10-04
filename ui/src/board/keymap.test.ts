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
        it(`${surface}: ${binding.alt ? 'Alt+' : ''}${key} → ${binding.intent}`, () => {
          expect(keyIntent(event(key === 'Shift+ ' ? ' ' : key, { altKey: binding.alt, shiftKey: key === 'Shift+ ' || /^[GJK?]$/.test(key) }), surface)).toBe(binding.intent)
        })
      }
    }
  }
  it.each(['1', '2', '3', ',', 'Tab'])('leaves chassis key %s alone', key => {
    for (const surface of ['desk', 'overview', 'reader'] as KeySurface[]) expect(keyIntent(event(key), surface)).toBeNull()
  })
  it.each(['input', 'textarea', 'select'])('ignores typing in %s but allows reader Alt-arrows', tag => {
    const field = document.createElement(tag)
    expect(keyIntent(event('j', {}, field), 'desk')).toBeNull()
    expect(keyIntent(event('ArrowRight', { altKey: true }, field), 'reader')).toBe('next')
    expect(shouldForwardDocumentKey(event('ArrowRight', { altKey: true }, field))).toBe(false)
  })
  it('guards nested contenteditable nodes and non-editable islands', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const child = document.createElement('span')
    editable.append(child)
    expect(keyIntent(event('j', {}, child), 'reader')).toBeNull()
    expect(shouldForwardDocumentKey(event('j', {}, child))).toBe(false)
    child.setAttribute('contenteditable', 'false')
    expect(keyIntent(event('j', {}, child), 'reader')).toBe('next')
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
  })
  it('allows held movement, not repeated activation or dismissal', () => {
    expect(keyIntent(event('j', { repeat: true }), 'desk')).toBe('down')
    for (const key of ['Enter', 'o', '?', 'Escape', 'u']) expect(keyIntent(event(key, { repeat: true }), 'desk')).toBeNull()
  })
})
