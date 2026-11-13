import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJsonSafe, writeJsonAtomic } from '../src/server/persist'
import { decodeCellsBase64, encodeCells } from '../src/shared/miniCodec'
import { pickColor, SESSION_COLORS } from '../src/shared/palette'
import { buildSpawnSpec, claudeResumeFlags, cleanEnv, resumeInput } from '../src/shared/spawnSpec'
import { isClaude } from '../src/ptyhost/procPoll'
import type { SessionConfig } from '../src/shared/types'

const isObj = (v: unknown): v is { n: number } => typeof (v as { n?: unknown })?.n === 'number'

describe('persist', () => {
  it('writes atomically and keeps a backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-'))
    const p = join(dir, 'state.json')
    writeJsonAtomic(p, { n: 1 })
    writeJsonAtomic(p, { n: 2 })
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ n: 2 })
    expect(JSON.parse(readFileSync(p + '.bak', 'utf8'))).toEqual({ n: 1 })
  })

  it('falls back to the backup when the main file is corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-'))
    const p = join(dir, 'state.json')
    writeJsonAtomic(p, { n: 1 })
    writeJsonAtomic(p, { n: 2 })
    writeFileSync(p, '{"n": 2, trunc')
    const r = readJsonSafe(p, isObj)
    expect(r.value).toEqual({ n: 1 })
    expect(r.warning).toBeTruthy()
  })
})

describe('miniCodec', () => {
  it('round-trips cells through base64', () => {
    const cells = new Uint32Array([0, 0x01ff0000, 0x02000000, 0x0100ff00])
    expect(Array.from(decodeCellsBase64(encodeCells(cells)))).toEqual(Array.from(cells))
  })
})

describe('palette', () => {
  it('picks an unused color far from the ones in use', () => {
    const first = pickColor([])
    const second = pickColor([first])
    expect(second).not.toBe(first)
    const used = SESSION_COLORS.slice(0, 11)
    expect(pickColor(used)).toBe(SESSION_COLORS[11])
  })
})

describe('spawnSpec', () => {
  const session: SessionConfig = { id: 'S1', number: 1, color: '#fff', cwd: '/tmp', inactive: false, queue: [] }
  const opts = {
    shell: '/bin/zsh',
    hookSocket: '/tmp/h.sock',
    cols: 100,
    rows: 30,
    scrollback: 1500,
    historyPath: '/tmp/h.log',
    baseEnv: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: 'x', HOME: '/h' }
  }

  it('strips env vars that break child Claude sessions', () => {
    expect(cleanEnv(opts.baseEnv)).toEqual({ PATH: '/bin', HOME: '/h' })
  })

  it('every session is an interactive login shell with Stack env', () => {
    const spec = buildSpawnSpec(session, { ...opts, initialInput: 'claude --resume x\r' })
    expect(spec.file).toBe('/bin/zsh')
    expect(spec.args).toEqual(['-l', '-i'])
    expect(spec.env.STACK_SID).toBe('S1')
    expect(spec.env.STACK_SOCK).toBe('/tmp/h.sock')
    expect(spec.env.DISABLE_AUTO_UPDATE).toBe('true')
    expect(spec.env.CLAUDECODE).toBeUndefined()
    expect(spec.initialInput).toBe('claude --resume x\r')
  })
})

describe('resume', () => {
  const base: SessionConfig = { id: 'S1', number: 1, color: '#fff', cwd: '/tmp', inactive: false, queue: [] }
  const exists = { transcriptExists: () => true }

  it('resumes Claude by session id, keeping permission flags', () => {
    const s: SessionConfig = { ...base, program: { kind: 'claude', sid: 'abc', flags: '--dangerously-skip-permissions' } }
    expect(resumeInput(s, exists)).toBe('claude --resume abc --dangerously-skip-permissions\r')
    expect(resumeInput(s, { ...exists, hooksPath: "/a b/h.json" })).toBe(`claude --resume abc --dangerously-skip-permissions --settings '/a b/h.json'\r`)
  })

  it('starts Claude fresh when the conversation was never saved', () => {
    const s: SessionConfig = { ...base, program: { kind: 'claude', sid: 'abc', flags: '--dangerously-skip-permissions' } }
    expect(resumeInput(s, { transcriptExists: () => false })).toBe('claude --dangerously-skip-permissions\r')
  })

  it('pre-types other programs without running them', () => {
    expect(resumeInput({ ...base, program: { kind: 'other', command: 'npm run dev' } }, exists)).toBe('npm run dev')
  })

  it('a resume override wins and runs', () => {
    expect(resumeInput({ ...base, resumeOverride: 'grok --resume', program: { kind: 'other', command: 'grok' } }, exists)).toBe('grok --resume\r')
  })

  it('plain shells resume nothing', () => {
    expect(resumeInput(base, exists)).toBeUndefined()
  })

  it('keeps only flags worth carrying over', () => {
    expect(claudeResumeFlags('claude --model opus --resume old -p hi --dangerously-skip-permissions --permission-mode plan fix the bug')).toBe(
      '--dangerously-skip-permissions --permission-mode plan'
    )
  })

  it('recognises claude in the foreground', () => {
    expect(isClaude('claude', 'claude --model opus')).toBe(true)
    expect(isClaude('/opt/homebrew/bin/claude', 'claude')).toBe(true)
    expect(isClaude('node', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe(false)
    expect(isClaude('node', 'node /usr/local/bin/claude')).toBe(true)
    expect(isClaude('vim', 'vim notes.md')).toBe(false)
  })
})
