import type { Browser } from 'playwright-core'

export function launchBrowser(options?: { args?: string[] }): Promise<Browser>
