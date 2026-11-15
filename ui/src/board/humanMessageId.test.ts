import { expect, it } from 'vitest'
import { HumanMessageIds } from './humanMessageId.js'

it('keeps one id per composed message until it is sent', () => {
  const ids = new HumanMessageIds()
  const first = ids.for('mask\0Keep it.')
  expect(ids.for('mask\0Keep it.')).toBe(first)
  expect(ids.for('mask\0Drop it.')).not.toBe(first)
  const second = ids.for('mask\0Keep it.')
  ids.sent()
  expect(ids.for('mask\0Keep it.')).not.toBe(second)
})
