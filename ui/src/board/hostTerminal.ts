import type { CompositeEntry } from './KanbanComposite.js'

export type TerminalHost = { host: string; terminal: 'rex' | 'tmux' }

/** Version describes only the daemon answering it, not every origin on its board. */
export function terminalHostFromVersion(value: unknown): TerminalHost | undefined {
  const version = value as Partial<TerminalHost> | null
  return version && typeof version.host === 'string' && (version.terminal === 'rex' || version.terminal === 'tmux')
    ? { host: version.host, terminal: version.terminal } : undefined
}

/** An owner-observed worker backend takes precedence over the host's configured default. */
export function applyTerminalHost(entries: readonly CompositeEntry[], host: TerminalHost | undefined): void {
  if (!host) return
  for (const entry of entries) {
    if (entry.origin === host.host && entry.runtime && !entry.runtime.terminalBackend) entry.runtime.terminalBackend = host.terminal
  }
}

/** Reads the answering daemon's terminal once, off the render path. A failed read
 *  is retried on the next refresh; a version without a terminal settles as none. */
export class TerminalHostReader {
  current?: TerminalHost
  private reading = false
  private settled = false

  private readonly read: () => Promise<Response>
  private readonly learned: () => void

  constructor(read: () => Promise<Response>, learned: () => void) {
    this.read = read
    this.learned = learned
  }

  refresh(): void {
    if (this.settled || this.reading) return
    this.reading = true
    void this.read()
      .then(async response => {
        if (!response.ok) return
        this.settled = true
        this.current = terminalHostFromVersion(await response.json())
        if (this.current) this.learned()
      })
      .catch(() => {})
      .finally(() => { this.reading = false })
  }
}
