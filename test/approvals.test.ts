import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Controller } from '../src/server/controller'
import { DEFAULT_SETTINGS } from '../src/shared/themes'

// Approval runs: a permission prompt elsewhere pulls you to it, answering walks you through the
// rest (oldest first), then you're taken back to where you started.

let dir: string
let sendOffs: { id: string; target: string; reason: string; left: number }[]
let c: Controller

function setup(): void {
  dir = mkdtempSync(join(tmpdir(), 'deepstack-approvals-'))
  const session = (id: string, number: number) => ({ id, number, color: 'blue', cwd: dir, inactive: false, queue: [] })
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      version: 1,
      sessions: [session('A', 1), session('B', 2), session('C', 3)],
      activeId: 'A',
      settings: { ...DEFAULT_SETTINGS },
      customThemes: [],
      nextNumber: 4,
      // Never touch the real ~/.claude/settings.json from a test.
      hooksOptOut: true
    })
  )
  sendOffs = []
  c = new Controller({
    paths: { state: join(dir, 'state.json'), snapshots: join(dir, 'snapshots'), history: join(dir, 'history'), hooksFile: join(dir, 'hooks.json'), socket: join(dir, 'h.sock') },
    host: () => {},
    broadcast: () => {},
    sendOff: (id, target, _ms, reason, left) => sendOffs.push({ id, target, reason, left }),
    snap: () => {},
    quit: () => {},
    shell: '/bin/zsh',
    home: dir
  })
}

const hook = (sid: string, name: string) => c.onHook({ sid, name, payload: {} } as never)
/** A permission prompt appears in this session. */
const ask = (id: string) => {
  hook(id, 'PermissionRequest')
  vi.advanceTimersByTime(10)
}
/** The human answers the prompt in the focused session. */
const answer = (id: string) => {
  c.onInput(id)
  hook(id, 'UserPromptSubmit')
}
/** Let the send-off window run out. */
const land = () => vi.advanceTimersByTime(DEFAULT_SETTINGS.sendOffMs + 10)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'))
  setup()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('approval runs', () => {
  it('grabs you, walks the queue oldest first, then returns you', () => {
    ask('C')
    // C's grab is already announced when B's prompt arrives; B joins the queue behind it.
    ask('B')
    expect(sendOffs).toEqual([{ id: 'A', target: 'C', reason: 'approval', left: 0 }])
    land()
    expect(c.state.activeId).toBe('C')

    answer('C')
    expect(sendOffs.at(-1)).toEqual({ id: 'C', target: 'B', reason: 'next', left: 0 })
    land()
    expect(c.state.activeId).toBe('B')

    hook('B', 'Stop') // answered "No": Claude stops
    expect(sendOffs.at(-1)).toEqual({ id: 'B', target: 'A', reason: 'return', left: 0 })
    land()
    expect(c.state.activeId).toBe('A')
    // Answering suppressed the ordinary send-off throughout.
    expect(sendOffs.some((s) => s.reason === 'sendOff')).toBe(false)
  })

  it('never pulls you out of an approval you have not answered', () => {
    ask('B')
    land()
    expect(c.state.activeId).toBe('B')
    const before = sendOffs.length
    ask('C')
    vi.advanceTimersByTime(10_000)
    expect(sendOffs.length).toBe(before)
    expect(c.state.activeId).toBe('B')
  })

  it('snap mode does not pull you out of an approval either', () => {
    c.intent({ t: 'setSettings', settings: { snapToHigher: true } })
    c.intent({ t: 'activate', id: 'C' })
    hook('C', 'PermissionRequest')
    // A (above C) finishes: snap would normally jump there.
    hook('A', 'UserPromptSubmit')
    hook('A', 'Stop')
    expect(c.state.activeId).toBe('C')
  })

  it('a session that went quiet waiting on its own background task does not snap you to it', () => {
    c.intent({ t: 'setSettings', settings: { snapToHigher: true } })
    c.intent({ t: 'activate', id: 'C' })
    const transcript = join(dir, 'a.jsonl')
    const line = (text: string) =>
      JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', content: text }] } })
    writeFileSync(transcript, line('Command did not complete within its 120s timeout and was moved to the background (ID: bo73yef9p). Output') + '\n')
    const withPath = (name: string) => c.onHook({ sid: 'A', name, payload: { transcript_path: transcript } } as never)
    withPath('UserPromptSubmit')
    withPath('Stop')
    expect(c.state.runtime.A.background).toBe(true)
    expect(c.state.activeId).toBe('C')

    // Once it reports back and Claude really finishes, A snaps you up as usual.
    writeFileSync(transcript, line('Command did not complete within its 120s timeout and was moved to the background (ID: bo73yef9p). Output') + '\n' +
      JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: '<task-notification>\n<task-id>bo73yef9p</task-id>' } }) + '\n')
    withPath('UserPromptSubmit')
    withPath('Stop')
    expect(c.state.runtime.A.background).toBe(false)
    expect(c.state.activeId).toBe('A')
  })

  it('waits until you have stopped typing', () => {
    c.onInput('A')
    ask('B')
    expect(sendOffs).toEqual([])
    vi.advanceTimersByTime(2600)
    expect(sendOffs).toEqual([{ id: 'A', target: 'B', reason: 'approval', left: 0 }])
  })

  it('ends the run when you switch yourself', () => {
    ask('B')
    land()
    c.intent({ t: 'activate', id: 'A' })
    ask('C')
    vi.advanceTimersByTime(2600)
    // A fresh run (not "next"), starting with B: it's still unanswered and has waited longest.
    expect(sendOffs.at(-1)).toEqual({ id: 'A', target: 'B', reason: 'approval', left: 1 })
  })

  it('skips parked sessions', () => {
    c.intent({ t: 'move', id: 'B', inactive: true, index: 0 })
    ask('B')
    vi.advanceTimersByTime(10_000)
    expect(sendOffs).toEqual([])
  })

  it('Space ("stay") leaves those approvals alone until they are answered', () => {
    ask('B')
    c.intent({ t: 'setHold', hold: true })
    c.intent({ t: 'setHold', hold: false })
    vi.advanceTimersByTime(10_000)
    expect(sendOffs.length).toBe(1)
    expect(c.state.activeId).toBe('A')
  })

  it('does nothing when Jump to approvals is off', () => {
    c.intent({ t: 'setSettings', settings: { grabApprovals: false } })
    ask('B')
    vi.advanceTimersByTime(10_000)
    expect(sendOffs).toEqual([])
  })
})

describe('queued messages', () => {
  it('revising one keeps its place, id and age; emptying it removes it', () => {
    c.intent({ t: 'enqueue', id: 'A', text: 'first' })
    c.intent({ t: 'enqueue', id: 'A', text: 'secnod' })
    c.intent({ t: 'enqueue', id: 'A', text: 'third' })
    const before = c.state.sessions[0].queue.map((q) => ({ ...q }))
    c.intent({ t: 'updateQueued', id: 'A', itemId: before[1].id, text: 'second' })
    const after = c.state.sessions[0].queue
    expect(after.map((q) => q.text)).toEqual(['first', 'second', 'third'])
    expect(after[1].id).toBe(before[1].id)
    expect(after[1].createdAt).toBe(before[1].createdAt)
    c.intent({ t: 'updateQueued', id: 'A', itemId: before[0].id, text: '   ' })
    expect(c.state.sessions[0].queue.map((q) => q.text)).toEqual(['second', 'third'])
  })
})

describe('slash commands', () => {
  const sendOffsNow = () => sendOffs.filter((s) => s.reason === 'sendOff')
  const submit = (text: string) => {
    hook('A', 'SessionStart')
    for (const ch of text) c.onInput('A', ch)
    c.onInput('A', '\r')
    hook('A', 'UserPromptSubmit')
  }

  it('a quick one (/context) does not send you off', () => {
    submit('/context')
    hook('A', 'Stop')
    vi.advanceTimersByTime(3000)
    expect(sendOffsNow()).toEqual([])
    expect(c.state.activeId).toBe('A')
  })

  it('one that keeps Claude busy (a skill, /compact) sends you off after the grace', () => {
    submit('/compact')
    vi.advanceTimersByTime(1000)
    expect(sendOffsNow()).toEqual([])
    vi.advanceTimersByTime(2000)
    expect(sendOffsNow().map((s) => s.id)).toEqual(['A'])
  })

  it('an ordinary prompt still sends you off at once, even one starting with a path', () => {
    submit('/tmp/log.txt has the error, fix it')
    expect(sendOffsNow().map((s) => s.id)).toEqual(['A'])
  })
})
