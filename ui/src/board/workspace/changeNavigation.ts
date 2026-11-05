import { el, button, save, stored } from './changeElements.js'

/** Contents, viewed progress and scroll anchors belong to this mounted reader. */
export function createChangeNavigation(
  shell: HTMLElement,
  rail: HTMLElement,
  scroll: HTMLElement,
  main: HTMLElement,
  prefix: string,
) {
  const disposers: (() => void)[] = []
  const viewed = new Set(stored<string[]>(`${prefix}:viewed`, []))
  let destination: { element: () => Element | null | undefined; offset: number } | undefined
  const alignDestination = (): void => {
    const element = destination?.element()
    if (element?.isConnected)
      scroll.scrollTop +=
        element.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        destination!.offset
  }
  const reveal = (element: Element, center = false): void => {
    destination = { element: () => element, offset: center ? scroll.clientHeight / 2 : 16 }
    alignDestination()
  }
  const releaseDestination = (): void => {
    destination = undefined
  }
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    shell.addEventListener(type, releaseDestination, { passive: true })
    disposers.push(() => shell.removeEventListener(type, releaseDestination))
  }
  const progress = el('span', 'change-progress')
  const railTitle = el('div', 'change-contents-title', 'Read the change')
  railTitle.append(progress)
  rail.append(railTitle)
  const sections: {
    element: HTMLElement
    link: HTMLButtonElement
    ids: string[]
    label: string
  }[] = []
  const marks = new Map<string, HTMLButtonElement[]>()
  const updateProgress = (): void => {
    const ids = [...marks.keys()]
    progress.textContent = `${ids.filter((id) => viewed.has(id)).length}/${ids.length}`
    for (const [id, controls] of marks)
      for (const control of controls) {
        control.setAttribute('aria-pressed', String(viewed.has(id)))
        control.textContent = viewed.has(id) ? '✓ Viewed' : 'Mark viewed'
      }
    for (const section of sections) {
      section.link.textContent = section.ids.length
        ? `${section.label}  ${section.ids.filter((id) => viewed.has(id)).length}/${section.ids.length}`
        : section.label
    }
    save(`${prefix}:viewed`, [...viewed])
  }
  const mark = (id: string): HTMLButtonElement => {
    const control = button('Mark viewed', () => {
      if (viewed.has(id)) viewed.delete(id)
      else viewed.add(id)
      updateProgress()
    })
    control.className = 'change-viewed'
    control.dataset.viewId = id
    marks.set(id, [...(marks.get(id) ?? []), control])
    return control
  }
  const section = (
    title: string,
    description?: string,
  ): { element: HTMLElement; link: HTMLButtonElement; ids: string[]; label: string } => {
    const element = el('section', 'change-section')
    element.append(el('h2', '', title))
    if (description) element.append(el('p', 'change-section-note', description))
    const link = button(title, () => reveal(element))
    rail.append(link)
    main.append(element)
    const entry = { element, link, ids: [] as string[], label: title }
    element.dataset.windowId = `section:${sections.length}`
    sections.push(entry)
    return entry
  }
  let railFrame = 0
  const paintLocation = (): void => {
    railFrame = 0
    const top = scroll.getBoundingClientRect().top + 100
    const active = sections
      .filter((section) => section.element.getBoundingClientRect().top <= top)
      .at(-1)
    for (const section of sections) {
      const current = section === active ? 'location' : 'false'
      if (section.link.getAttribute('aria-current') !== current)
        section.link.setAttribute('aria-current', current)
    }
  }
  const scheduleLocation = (): void => {
    if (!railFrame) railFrame = requestAnimationFrame(paintLocation)
  }
  // Keep explicit navigation anchored while nearby diff windows acquire their wrapped height.
  const locationResize = new ResizeObserver(() => {
    alignDestination()
    scheduleLocation()
  })
  locationResize.observe(scroll)
  locationResize.observe(main)
  scroll.addEventListener('scroll', scheduleLocation, { passive: true })
  scheduleLocation()
  disposers.push(() => {
    locationResize.disconnect()
    cancelAnimationFrame(railFrame)
    scroll.removeEventListener('scroll', scheduleLocation)
  })
  rail.addEventListener('keydown', (event) => {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    )
      return
    const links = [...rail.querySelectorAll('button')],
      index = links.indexOf(event.target as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? links.length - 1
          : Math.max(
              0,
              Math.min(
                links.length - 1,
                index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1),
              ),
            )
    event.preventDefault()
    event.stopPropagation()
    links[next]?.focus()
  })
  const stopKeys = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && (event.target as Element)?.matches('textarea')) {
      event.preventDefault()
      event.stopPropagation()
      ;(event.target as HTMLElement).blur()
    }
  }
  shell.addEventListener('keydown', stopKeys)
  return {
    section,
    mark,
    reveal,
    sections,
    updateProgress,
    isViewed: (id: string) => viewed.has(id),
    anchor(element: () => Element | null | undefined, offset: number, ready: Promise<void>) {
      const target = { element, offset }
      destination = target
      void ready.then(() => {
        if (destination === target) alignDestination()
      })
    },
    dispose() {
      for (const dispose of disposers) dispose()
      shell.removeEventListener('keydown', stopKeys)
    },
  }
}
