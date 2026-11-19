import { describe, expect, it, vi } from 'vitest'
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { attachLinks } from '../src/renderer/src/lib/termLinks'

/** A fake terminal: rows of `cols` cells, plus which rows continue the previous one. */
function fakeTerm(rows: string[], cols: number, wrapped: number[] = []) {
  let provider: ILinkProvider | undefined
  const line = (y: number) => {
    const t = rows[y]
    if (t === undefined) return undefined
    return {
      isWrapped: wrapped.includes(y),
      length: cols,
      getCell: (x: number) => ({ getWidth: () => 1, getChars: () => t[x] ?? '' })
    }
  }
  const term = {
    options: {} as Record<string, unknown>,
    buffer: { active: { getLine: line } },
    registerLinkProvider: (p: ILinkProvider) => {
      provider = p
      return { dispose() {} }
    }
  }
  attachLinks(term as unknown as Terminal)
  const links = (y: number) =>
    new Promise<ILink[]>((res) => provider!.provideLinks(y, (l) => res(l ?? [])))
  return { term, links }
}

describe('terminal links', () => {
  it('finds a URL and trims the sentence around it', async () => {
    const { links } = fakeTerm(['see (https://github.com/lukeprofits/DeepStack).'], 60)
    const [l] = await links(1)
    expect(l.text).toBe('https://github.com/lukeprofits/DeepStack')
    expect(l.range.start).toEqual({ x: 6, y: 1 })
    expect(l.range.end).toEqual({ x: 45, y: 1 })
  })

  it('keeps brackets that belong to the URL', async () => {
    const { links } = fakeTerm(['https://en.wikipedia.org/wiki/Foo_(bar)'], 60)
    expect((await links(1))[0].text).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
  })

  it('treats a URL the terminal wrapped as one link, from either row', async () => {
    const { links } = fakeTerm(['go https://exa', 'mple.com/path ok'], 14, [1])
    for (const y of [1, 2]) {
      const [l] = await links(y)
      expect(l.text).toBe('https://example.com/path')
      expect(l.range.start).toEqual({ x: 4, y: 1 })
      expect(l.range.end).toEqual({ x: 13, y: 2 })
    }
  })

  it('opens the link in a new browser tab, and OSC 8 links without a prompt', async () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    const { term, links } = fakeTerm(['https://a.b/c'], 20)
    ;(await links(1))[0].activate({} as MouseEvent, 'https://a.b/c')
    const handler = term.options.linkHandler as { activate: (e: unknown, u: string) => void }
    handler.activate(null, 'https://x.y/osc8')
    expect(open.mock.calls.map((c) => c[0])).toEqual(['https://a.b/c', 'https://x.y/osc8'])
    vi.unstubAllGlobals()
  })

  it('joins a URL the program broke with a newline at its width (Claude after a resize)', async () => {
    const rows = ['  see https://exa', '  mple.com/a/b', 'next']
    const { links } = fakeTerm(rows, 17)
    for (const y of [1, 2]) {
      const [l] = await links(y)
      expect(l.text).toBe('https://example.com/a/b')
      expect(l.range.start).toEqual({ x: 7, y: 1 })
      expect(l.range.end).toEqual({ x: 14, y: 2 })
    }
  })

  it('joins a URL broken at a slash inside the right margin (Claude Code)', async () => {
    const rows = ['  rows: https://github.com/x/blob', '  /main/src/a.ts?plain=1#L1-L57', '']
    const { links } = fakeTerm(rows, 36)
    for (const y of [1, 2]) {
      const [l] = await links(y)
      expect(l.text).toBe('https://github.com/x/blob/main/src/a.ts?plain=1#L1-L57')
      expect(l.range.end).toEqual({ x: 31, y: 2 })
    }
  })

  it('does not join a URL that ends before the edge, or prose after it', async () => {
    const near = fakeTerm(['  see https://a.b/c', '  and then more'], 22)
    expect((await near.links(1))[0].text).toBe('https://a.b/c')
    expect(await near.links(2)).toEqual([])
    const { links } = fakeTerm(['  https://a.b/c', '  more text'], 30)
    expect((await links(1))[0].text).toBe('https://a.b/c')
    expect(await links(2)).toEqual([])
  })

  it('ignores lines without links', async () => {
    const { links } = fakeTerm(['nothing here, just http talk'], 40)
    expect(await links(1)).toEqual([])
  })
})
