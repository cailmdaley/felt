import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { changeNotices } from '../scripts/change-notices.mjs'

it('distributes the diff renderer dependency licenses and upstream notices with the board', () => {
  const notices = readFileSync(new URL('../public/change-reader-NOTICES.txt', import.meta.url), 'utf8')
  expect(notices).toBe(changeNotices())
  expect(notices).toContain('@pierre/diffs 1.6.4')
  expect(notices).toContain('Apache License')
  expect(notices).toContain('Copyright (c) 2010-2016 Rasmus Andersson')
})
