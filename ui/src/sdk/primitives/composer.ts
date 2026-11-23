import '@ui-sdk/web/segmented-control'
import type { ShuttleClient } from '../client.js'
import { notify } from '../notify.js'
import type { ShuttleFiber } from '../types.js'
import { button, flag, isBusy, part, setBusy } from './dom.js'

/**
 * How a message reaches the worker: `continue` as the worker's state chooses
 * (typed into a live one, else resumed or started), `fresh` in a new
 * conversation, which cuts a live one, or `previous` resuming the last.
 */
export type ComposerMode = 'continue' | 'fresh' | 'previous'

const MODE_LABEL: Record<ComposerMode, string> = { continue: 'Continue', fresh: 'Fresh', previous: 'Previous' }

export interface ComposerOptions {
  /** Offer the send modes; off by default, which sends as `continue`. */
  modes?: boolean
  defaultMode?: ComposerMode
  placeholder?: string
  /** The form's accessible name. */
  label?: string
  /** Mints a draft's message id; a random one by default. A retry of the same text in the same mode keeps its id, so the owner takes it once. */
  messageId?(text: string): string
  onSent?(result: unknown, text: string): void
  onError?(error: unknown, text: string): void
}

const randomId = (): string => `human-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`

/** The owner took nothing because this id came before, and cannot say that first send arrived. */
const unconfirmed = (result: Record<string, unknown> | undefined): boolean => result?.duplicate === true && result.disposition !== 'delivered'

/**
 * A message to a fiber's worker, `<form data-slot="shuttle-composer">`: its
 * `input` textarea, optional `modes` holding a segmented control
 * (`@ui-sdk/web/segmented-control`: continue, fresh, previous) and its
 * `submit` button. Submitting (or ⌘/Ctrl+Enter in the input) sends the text
 * through a forced `client.dispatch`, which reaches a live worker and starts a
 * draft, resting or closed fiber; while it is in flight the form is
 * `aria-busy` and `data-pending`, and its button `aria-disabled`, keeping the
 * focus. A sent message clears the input; one refused, or whose first send
 * the owner cannot confirm, stays in it.
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
  /** The message composed and the id every try of it goes out under. */
  let draft: { key: string; id: string } | undefined
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
    if (!text || isBusy(form)) return
    const key = `${mode}\0${text}`
    if (draft?.key !== key) draft = { key, id: (options.messageId ?? randomId)(text) }
    setBusy(form, true)
    flag(form, 'pending', true)
    submit.setAttribute('aria-disabled', 'true')
    let told: () => void
    try {
      const result = await client.dispatch({
        fiber_id: fiber.fiber.id,
        origin: fiber.origin,
        force: true,
        ad_hoc: true,
        resume_mode: mode,
        user_message: text,
        message_id: draft.id,
      })
      draft = undefined
      if (unconfirmed(result)) throw new Error('This message may not have arrived: its first send was interrupted. Check the conversation; sending it again sends it as a new message.')
      if (input.value.trim() === text) input.value = ''
      told = () => options.onSent?.(result, text)
    } catch (error) {
      told = () => options.onError?.(error, text)
    }
    setBusy(form, false)
    flag(form, 'pending', false)
    submit.removeAttribute('aria-disabled')
    notify(told)
  })
  return form
}
