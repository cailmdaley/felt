import type { CompositeEntry } from './KanbanComposite.js'

type TerminalHost = { host: string; terminal: 'rex' | 'tmux' }

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
