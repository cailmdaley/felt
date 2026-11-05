import type { ChangeBundle } from './changeModel.js'

export function validateChangeBundle(value: unknown): asserts value is ChangeBundle {
  if ((value as ChangeBundle)?.version !== 2) {
    throw new Error('This change needs to be rebaked with shuttle change (bundle version 2).')
  }
}

export function parseChangeBundle(source: string): ChangeBundle {
  const value: unknown = JSON.parse(source)
  validateChangeBundle(value)
  return value
}
