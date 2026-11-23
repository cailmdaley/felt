// ShuttleClient covers the daemon's whole stable tier: each route of
// contract/shuttle-api.json is named, with its method, by the method of the
// client that calls it.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('ShuttleClient calls every core route of the contract', () => {
  const contract = JSON.parse(readFileSync(resolve('../contract/shuttle-api.json'), 'utf8')) as { paths: Record<string, Record<string, unknown>> }
  const client = readFileSync(resolve('src/sdk/client.ts'), 'utf8')
  const routes = Object.entries(contract.paths).flatMap(([path, methods]) => Object.keys(methods).map(method => `${method.toUpperCase()} ${path}`))
  expect(routes.length).toBeGreaterThan(0)
  expect(routes.filter(route => !client.includes(`\`${route}\``))).toEqual([])
})
