import type { KanbanCard } from './KanbanTypes.js'

export interface RoleProfile { slug: string; name: string; outcome: string }
export interface RoleChoice { role: string; new_name?: string }

/** Mirrors shuttle.ValidRole: a one-level charter slug, never a path. */
export function validRole(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
}

/** Choose an office before making a seat. Closing the picker never writes. */
export function rolePopover(
  card: KanbanCard,
  anchor: HTMLElement,
  load: () => Promise<RoleProfile[]>,
  submit: (choice: RoleChoice) => Promise<void>,
): () => void {
  const previous = document.activeElement as HTMLElement | null
  let closed = false
  let roles: RoleProfile[] = []
  const scrim = document.createElement('div')
  scrim.className = 'kbn-role-scrim'
  const panel = document.createElement('div')
  panel.className = 'kbn-rest-popover kbn-role-popover'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', `Choose a role for ${card.name}`)
  const title = document.createElement('h2')
  title.className = 'kbn-rest-title'
  title.textContent = 'Make a seat'
  const subject = document.createElement('p')
  subject.className = 'kbn-rest-subject'
  subject.textContent = card.name
  const filter = document.createElement('input')
  filter.type = 'search'
  filter.placeholder = 'Filter roles…'
  filter.setAttribute('aria-label', 'Filter roles')
  const list = document.createElement('div')
  list.className = 'kbn-role-options'
  list.setAttribute('aria-label', 'Existing roles')
  const message = document.createElement('p')
  message.className = 'kbn-role-message'
  message.setAttribute('role', 'status')
  message.textContent = 'Loading roles…'
  const create = document.createElement('button')
  create.type = 'button'
  create.className = 'kbn-role-option'
  create.textContent = '+ New role'
  create.setAttribute('aria-expanded', 'false')
  const form = document.createElement('form')
  form.className = 'kbn-role-new'
  form.hidden = true
  const field = (label: string, value: string): HTMLInputElement => {
    const wrap = document.createElement('label')
    wrap.textContent = label
    const input = document.createElement('input')
    input.value = value
    input.required = true
    wrap.append(input)
    form.append(wrap)
    return input
  }
  const slug = field('Role slug', card.id.split('/').at(-1) ?? '')
  slug.pattern = '[a-z0-9]+(-[a-z0-9]+)*'
  const name = field('Office name', card.name)
  const confirm = document.createElement('button')
  confirm.type = 'submit'
  confirm.className = 'kbn-rest-confirm'
  confirm.textContent = 'Create role and make seat'
  form.append(confirm)
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'kbn-role-cancel'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', close)
  create.addEventListener('click', () => {
    form.hidden = !form.hidden
    create.setAttribute('aria-expanded', String(!form.hidden))
    if (!form.hidden) slug.focus()
  })
  const validate = (): boolean => {
    slug.setCustomValidity(validRole(slug.value) ? '' : 'Use lowercase letters and numbers separated by single hyphens.')
    name.setCustomValidity(name.value.trim() ? '' : 'Enter an office name.')
    return validRole(slug.value) && name.value.trim().length > 0
  }
  slug.addEventListener('input', validate)
  name.addEventListener('input', validate)
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (!validate()) { form.reportValidity(); return }
    finish({ role: slug.value, new_name: name.value.trim() })
  })
  function paint(): void {
    const query = filter.value.trim().toLowerCase()
    const matches = roles.filter(role => `${role.slug} ${role.name} ${role.outcome}`.toLowerCase().includes(query))
    list.replaceChildren(...matches.map(role => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'kbn-role-option'
      const label = document.createElement('strong')
      label.textContent = role.name || role.slug
      const detail = document.createElement('span')
      detail.textContent = [role.slug, role.outcome].filter(Boolean).join(' · ')
      button.append(label, detail)
      button.addEventListener('click', () => finish({ role: role.slug }))
      return button
    }))
    message.textContent = matches.length ? '' : 'No matching roles. You can create one below.'
  }
  filter.addEventListener('input', paint)
  panel.append(title, subject, filter, list, message, create, form, cancel)
  scrim.append(panel)
  document.body.append(scrim)
  const rect = anchor.getBoundingClientRect()
  const left = Math.max(16, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 16))
  panel.style.left = `${left}px`
  // Open toward the roomier side of the band. Keep the anchor fixed as the
  // async list arrives or the new-office form expands.
  if (rect.top >= window.innerHeight / 2) {
    const bottom = Math.max(16, window.innerHeight - rect.top + 8)
    panel.style.bottom = `${bottom}px`
    panel.style.maxHeight = `${window.innerHeight - bottom - 16}px`
  } else {
    const top = Math.max(16, rect.bottom + 8)
    panel.style.top = `${top}px`
    panel.style.maxHeight = `${Math.max(120, window.innerHeight - top - 16)}px`
  }

  function finish(choice: RoleChoice): void {
    close()
    void submit(choice)
  }
  function close(): void {
    if (closed) return
    closed = true
    document.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onKey, true)
    scrim.remove()
    if (previous?.isConnected) previous.focus({ preventScroll: true })
  }
  function onPointerDown(event: PointerEvent): void {
    if (!panel.contains(event.target as Node)) close()
  }
  function onKey(event: KeyboardEvent): void {
    // Keep the board's shortcuts out of the dialog; native input and button
    // behavior still runs unless this dialog implements the key itself.
    event.stopImmediatePropagation()
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    const stops = [...panel.querySelectorAll<HTMLElement>('input, button')].filter(el => !el.closest('[hidden]'))
    if (event.key === 'Tab') {
      event.preventDefault()
      const i = stops.indexOf(document.activeElement as HTMLElement)
      stops[(i + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus()
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !form.contains(document.activeElement)) {
      event.preventDefault()
      const choices = [filter, ...list.querySelectorAll<HTMLButtonElement>('button'), create]
      const i = choices.indexOf(document.activeElement as HTMLInputElement)
      choices[(i + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus()
    } else if (event.key === 'Enter' && document.activeElement === filter) {
      event.preventDefault()
      ;(list.querySelector<HTMLButtonElement>('button') ?? create).click()
    }
  }
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('keydown', onKey, true)
  filter.focus({ preventScroll: true })
  void load().then(result => { if (!closed) { roles = result; paint() } }).catch(error => {
    if (!closed) message.textContent = `Couldn't load roles: ${error instanceof Error ? error.message : String(error)}. You can still create one.`
  })
  return close
}
