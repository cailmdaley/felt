// @vitest-environment jsdom
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { publicPage, remotePage } from './remotePage'

const BOARD = 'http://hub.example.org:4000/'
const page = (head: string, body = ''): string => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

describe('publicPage', () => {
  it('takes a public https page as it is', () => {
    expect(publicPage('https://example.github.io/talks/deck/', [BOARD])).toBe('https://example.github.io/talks/deck/')
    expect(publicPage('  https://Example.org:8443/deck/?a=1#/3  ', [BOARD])).toBe('https://example.org:8443/deck/?a=1#/3')
  })

  it.each([
    ['plain http', 'http://example.org/deck/'],
    ['a script address', 'javascript:alert(1)'],
    ['a data document', 'data:text/html,<p>hi</p>'],
    ['credentials in the address', 'https://user:secret@example.org/'],
    ['a relative address', './deck.html'],
    ['loopback by name', 'https://localhost/'],
    ['loopback by name, fully qualified', 'https://localhost./'],
    ['a name under localhost', 'https://app.localhost/'],
    ['a single-label (MagicDNS) host', 'https://hub/'],
    ['a tailnet name', 'https://hub.tail1234.ts.net/'],
    ['a link-local name', 'https://printer.local/'],
    ['an internal name', 'https://build.internal/'],
    ['a home network name', 'https://router.home.arpa/'],
    ['the board\'s own host on another port', 'https://hub.example.org/'],
    ['the board\'s own host, fully qualified', 'https://HUB.example.org./deck/'],
  ])('refuses %s', (_, raw) => {
    expect(publicPage(raw, [BOARD])).toBeNull()
  })

  it('refuses the host of every daemon it is told of', () => {
    expect(publicPage('https://owner.example.net/deck/', [BOARD, 'https://owner.example.net/api/v1/file-assets/a/t.html'])).toBeNull()
  })

  it('refuses every spelling of an IPv4 address', () => {
    const spellings = (n: number): string[] => {
      const octets = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
      return [octets.join('.'), octets.map(o => `0x${o.toString(16)}`).join('.'), String(n), `0x${n.toString(16)}`, `${octets.join('.')}.`]
    }
    fc.assert(fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), n => {
      for (const host of spellings(n)) expect(publicPage(`https://${host}/`, [BOARD])).toBeNull()
    }), { seed: 4207, numRuns: 200 })
  })

  it('refuses every IPv6 address', () => {
    fc.assert(fc.property(fc.ipV6(), address => { expect(publicPage(`https://[${address}]/`, [BOARD])).toBeNull() }), { seed: 4207, numRuns: 200 })
  })
})

describe('remotePage', () => {
  it('reads the declaration from the head, whatever its case, with its entities decoded', () => {
    expect(remotePage(page('<meta charset="utf-8"><META NAME="Shuttle-Page" CONTENT="https://example.org/deck/?a=1&amp;b=2">'), [BOARD])).toBe('https://example.org/deck/?a=1&b=2')
  })

  it('reads nothing from a page without one, or with one only in its body', () => {
    expect(remotePage(page('<title>Report</title>', '<p>Hello</p>'), [BOARD])).toBeNull()
    expect(remotePage(page('', '<meta name="shuttle-page" content="https://example.org/deck/">'), [BOARD])).toBeNull()
  })

  it('reads a declaration that names a page it refuses as none', () => {
    expect(remotePage(page('<meta name="shuttle-page" content="https://127.0.0.1:4000/">'), [BOARD])).toBeNull()
  })
})
