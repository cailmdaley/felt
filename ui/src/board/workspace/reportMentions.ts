import type { mentionRuntime } from '../workspace/bodyLinks.js'

/** Serialized into the opaque report; only its parent can supply resolved presentation data. */
export function reportMentionRuntime(mentions: typeof mentionRuntime, css: string, limits: { count: number; length: number }, active: () => boolean): () => void {
  const protocol = 'shuttle-constitution-mentions'
  const style = document.createElement('style'); style.textContent = css
  ;(document.head ?? document.documentElement).append(style)
  let chips: ReturnType<typeof mentions> | undefined
  const receive = (event: MessageEvent): void => {
    const data = event.data
    if (event.source !== parent || data?.protocol !== protocol) return
    if (data.type === 'scan' && !chips) {
      chips = mentions(document.body,
        (id, origin) => { if (active()) parent.postMessage({ protocol, type: 'open', id, origin }, '*') },
        candidates => {
          const chunks = Math.max(1, Math.ceil(candidates.length / limits.count))
          for (let i = 0; i < chunks; i++) parent.postMessage({ protocol, type: 'candidates',
            candidates: candidates.slice(i * limits.count, (i + 1) * limits.count).filter(candidate => candidate.length <= limits.length), reset: i === 0, done: i === chunks - 1 }, '*')
        })
      chips.update([])
    } else if (data.type === 'resolved' && Array.isArray(data.rows) && data.targets && typeof data.targets === 'object') {
      for (const name of ['ink', 'ink-muted', 'sheet', 'hairline', 'agent', 'owed', 'tempered']) {
        const value = data.colors?.[name]
        if (typeof value === 'string' && value.length <= 256 && CSS.supports('color', value.trim())) document.body.style.setProperty(`--shuttle-chip-${name}`, value.trim())
      }
      chips?.update(data.rows, data.targets)
    }
  }
  window.addEventListener('message', receive)
  return () => { window.removeEventListener('message', receive); chips?.dispose() }
}
