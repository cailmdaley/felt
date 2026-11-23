import '@ui-sdk/web/segmented-control'
import type { ShuttleClient } from '../client.js'
import type { ShuttleFiber } from '../types.js'
import { button, flag, part } from './dom.js'

/** How a message reaches the worker: as the owner decides, in a fresh conversation, or resuming the previous one. */
export type ComposerMode = 'continue' | 'fresh' | 'previous'

const MODE_LABEL: Record<ComposerMode, string> = { continue: 'Continue', fresh: 'Fresh', previous: 'Previous' }

export interface ComposerOptions {
  /** Offer the send modes; off by default, which sends as `continue`. */
  modes?: boolean
  defaultMode?: ComposerMode
  placeholder?: string
  /** The form's accessible name. */
  label?: string
  /** A message id per send; a random one by default. Give the same id to a retry of the same message. */
  messageId?(text: string): string
  onSent?(result: unknown, text: string): void
  onError?(error: unknown, text: string): void
}

const randomId = (): string => `human-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`

/**
 * A message to a fiber's worker, `<form data-slot="shuttle-composer">`: its
 * `input` textarea, optional `modes` holding a segmented control
 * (`@ui-sdk/web/segmented-control`: continue, fresh, previous) and its
 * `submit` button. Submitting (or ⌘/Ctrl+Enter in the input) sends the text
 * through `client.dispatch`; while it is in flight the form is `aria-busy`
 * and `data-pending`. A sent message clears the input.
 */
export function createComposer(fiber: ShuttleFiber, client: ShuttleClient, options: ComposerOptions = {}): HTMLFormElement {
  const form = part('form', 'shuttle-composer')
  form.setAttribute('aria-label', options.label ?? `Message ${fiber.fiber.name}`)
  const input = part('textarea', 'input')
  input.name = 'message'
  input.rows = 2
  input.setAttribute('aria-label', 'Message')
  if (options.placeholder) input.placeholder = options.placeholder
  let mode: ComposerMode = options.defaultMode ?? 'continue'
  form.append(input)
  if (options.modes) {
    const modes = part('div', 'modes')
    const control = document.createElement('ui-segmented-control')
    control.setAttribute('aria-label', 'Send mode')
    control.setAttribute('default-value', mode)
    for (const value of Object.keys(MODE_LABEL) as ComposerMode[]) {
      const item = document.createElement('ui-segmented-control-item')
      item.setAttribute('value', value)
      item.textContent = MODE_LABEL[value]
      control.append(item)
    }
    control.addEventListener('valuechange', event => { mode = event.detail.value as ComposerMode })
    modes.append(control)
    form.append(modes)
  }
  const submit = button('submit', 'Send')
  submit.type = 'submit'
  form.append(submit)
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    form.requestSubmit()
  })
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text || form.hasAttribute('aria-busy')) return
    form.toggleAttribute('aria-busy', true)
    flag(form, 'pending', true)
    submit.disabled = true
    try {
      const result = await client.dispatch({
        fiber_id: fiber.fiber.id,
        origin: fiber.origin,
        user_message: text,
        message_id: (options.messageId ?? randomId)(text),
        ...(mode === 'continue' ? {} : { resume_mode: mode }),
      })
      if (input.value.trim() === text) input.value = ''
      options.onSent?.(result, text)
    } catch (error) {
      options.onError?.(error, text)
    } finally {
      form.toggleAttribute('aria-busy', false)
      flag(form, 'pending', false)
      submit.disabled = false
    }
  })
  return form
}
