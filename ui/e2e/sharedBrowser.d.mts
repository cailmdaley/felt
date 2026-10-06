export interface SharedBrowserStatus {
  running: boolean
  state: 'running' | 'unresponsive' | 'orphaned' | 'stopped'
  pid: number | null
  endpoint: string | null
  browserPath: string | null
  processCount: number
  rssKiB: number
  rssMiB: number
  lastUsedAt: number | null
}

export interface SharedBrowser {
  readonly port: number
  readonly profileDir: string
  readonly logFile: string
  readonly args: string[]
  endpoint(): Promise<string>
  status(): Promise<SharedBrowserStatus>
  stop(): Promise<boolean>
  reap(minutes: number): Promise<{ result: string; pid?: number | null; targetCount?: number; idleForMs?: number }>
  withLock<T>(action: () => Promise<T>): Promise<T>
}

export function sharedBrowser(options?: Record<string, unknown>): SharedBrowser
export function findBrowser(options?: Record<string, unknown>): Promise<string>
export function main(argv: string[], browser?: SharedBrowser): Promise<void>
