import type { BrowserContext, BrowserContextOptions, Page } from 'playwright-core'
import type { SharedBrowser } from './sharedBrowser.mjs'

export interface BrowserSession {
  readonly shared: boolean
  isConnected(): boolean
  newContext(options?: BrowserContextOptions): Promise<BrowserContext>
  newPage(options?: BrowserContextOptions): Promise<Page>
  close(): Promise<void>
}

export function getBrowser(options?: { args?: string[]; executablePath?: string; sharedBrowser?: SharedBrowser }): Promise<BrowserSession>
export function sharedBrowserAvailable(sharedBrowser?: SharedBrowser): Promise<boolean>
