import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalTheme } from '../../../shared/types'
import { port, stack } from '../lib/port'

interface Props {
  sessionId: string | null
  /** Receives keystrokes and reports its size. Only the front layer is interactive. */
  interactive: boolean
  theme: TerminalTheme
  fontFamily: string
  scrollback: number
  /** Drop keystrokes until this time (ms epoch), so typing doesn't spill into a session we just switched to. */
  inputBlockedUntil: number
  onFocusTerminal: () => void
  className?: string
}

export interface TerminalLayerHandle {
  el: HTMLDivElement | null
  focus(): void
}

const MAX_HISTORY = 50_000
const HISTORY_STEP = 3_000

// Glyphs glow in CRT themes via a CSS drop-shadow; a transparent canvas keeps the glow off
// the background rectangle. The quiet scrollbar shows only as a faint thumb.
function xtermTheme(theme: TerminalTheme) {
  return {
    ...theme,
    background: '#00000000',
    scrollbarSliderBackground: 'rgba(128,128,128,0.18)',
    scrollbarSliderHoverBackground: 'rgba(128,128,128,0.32)',
    scrollbarSliderActiveBackground: 'rgba(128,128,128,0.42)'
  }
}

/**
 * A terminal view of one session. The screen is rebuilt from the pty host's serialized state
 * on attach, then follows live output by sequence number so nothing is lost or doubled. Two of
 * these take turns as the big terminal so the next session can be ready behind the current one.
 */
export const TerminalLayer = forwardRef<TerminalLayerHandle, Props>(function TerminalLayer(
  { sessionId, interactive, theme, fontFamily, scrollback, inputBlockedUntil, onFocusTerminal, className },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const live = useRef({ interactive, scrollback, inputBlockedUntil, onFocusTerminal })
  live.current = { interactive, scrollback, inputBlockedUntil, onFocusTerminal }

  // Attach bookkeeping, shared by the effects below.
  const attach = useRef({
    id: null as string | null,
    waiting: false,
    buffered: [] as { seq: number; d: string }[],
    historyLines: 0,
    historyLoading: false,
    historyComplete: false
  })

  useImperativeHandle(ref, () => ({
    get el() {
      return hostRef.current
    },
    focus: () => termRef.current?.focus()
  }))

  useEffect(() => {
    const term = new Terminal({
      fontFamily,
      fontSize: 13,
      lineHeight: 1.15,
      theme: xtermTheme(theme),
      scrollback,
      allowProposedApi: true,
      allowTransparency: true,
      cursorBlink: false,
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* falls back to the DOM renderer */
    }
    termRef.current = term
    fitRef.current = fit

    term.onData((data) => {
      const id = attach.current.id
      if (!id) return
      // A background layer still answers terminal queries; only the front layer takes typing.
      const isReply = data.startsWith('\x1b')
      if (!live.current.interactive && !isReply) return
      if (Date.now() < live.current.inputBlockedUntil && !isReply) return
      port.send({ t: 'input', id, data })
    })
    term.textarea?.addEventListener('focus', () => live.current.onFocusTerminal())

    // On-demand deep history: when the user scrolls to the top of what's loaded and older
    // lines were trimmed, ask the host to replay its on-disk log with a bigger scrollback.
    term.onScroll((y) => {
      const a = attach.current
      const buf = term.buffer.active
      if (y !== 0 || buf.type !== 'normal' || a.historyLoading || a.historyComplete || !a.id) return
      const limit = term.options.scrollback ?? live.current.scrollback
      if (buf.baseY < limit) return
      a.historyLoading = true
      a.historyLines = Math.min(MAX_HISTORY, Math.max(limit, a.historyLines) + HISTORY_STEP)
      port.send({ t: 'history', id: a.id, lines: a.historyLines })
    })

    const write = (d: string) => term.write(d)

    const off = port.on((msg) => {
      const a = attach.current
      if (msg.id !== a.id) return
      if (msg.t === 'attached') {
        term.reset()
        term.options.scrollback = live.current.scrollback
        a.historyLines = 0
        a.historyComplete = false
        a.historyLoading = false
        if (msg.ansi) term.write(msg.ansi)
        for (const b of a.buffered) if (b.seq > msg.seq) write(b.d)
        a.buffered = []
        a.waiting = false
      } else if (msg.t === 'data') {
        if (a.waiting || a.historyLoading) a.buffered.push({ seq: msg.seq, d: msg.d })
        else write(msg.d)
      } else if (msg.t === 'history') {
        const buf = term.buffer.active
        const fromBottom = buf.baseY - buf.viewportY
        term.options.scrollback = msg.lines
        term.reset()
        term.write(msg.ansi, () => {
          // Keep the same line under the user's eye as before the reload.
          term.scrollToLine(Math.max(0, term.buffer.active.baseY - fromBottom))
        })
        for (const b of a.buffered) if (b.seq > msg.seq) write(b.d)
        a.buffered = []
        a.historyComplete = msg.complete || msg.lines >= MAX_HISTORY
        a.historyLoading = false
      }
    })

    let resizeTimer = 0
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        try {
          fit.fit()
          if (live.current.interactive) void stack.intent({ t: 'resize', cols: term.cols, rows: term.rows })
        } catch {
          /* not laid out yet */
        }
      }, 40)
    })
    ro.observe(hostRef.current!)

    return () => {
      off()
      ro.disconnect()
      if (attach.current.id) port.send({ t: 'detach', id: attach.current.id })
      term.dispose()
      termRef.current = null
    }
    // The terminal is created once; option changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow a session.
  useEffect(() => {
    const a = attach.current
    if (a.id && a.id !== sessionId) port.send({ t: 'detach', id: a.id })
    a.id = sessionId
    a.waiting = !!sessionId
    a.buffered = []
    termRef.current?.reset()
    if (!sessionId) return
    const doAttach = () => port.send({ t: 'attach', id: sessionId, scrollback: live.current.scrollback })
    doAttach()
    return port.onConnect(doAttach)
  }, [sessionId])

  useEffect(() => {
    if (interactive) termRef.current?.focus()
  }, [interactive, sessionId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = xtermTheme(theme)
    term.options.fontFamily = fontFamily
    try {
      fitRef.current?.fit()
    } catch {
      /* ignore */
    }
  }, [theme, fontFamily])

  return <div className={`term-layer ${className ?? ''}`} ref={hostRef} />
})
