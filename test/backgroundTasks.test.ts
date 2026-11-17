import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKGROUND_MAX_AGE_MS, findTranscript, pendingBackgroundTasks } from '../src/server/backgroundTasks'

// Shapes as Claude Code writes them to its transcript (trimmed).
const NOW = Date.parse('2026-11-17T16:30:00Z')
const ts = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const toolResult = (text: string, msAgo = 60_000) =>
  JSON.stringify({ type: 'user', timestamp: ts(msAgo), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } })
const userText = (text: string, msAgo = 60_000) => JSON.stringify({ type: 'user', timestamp: ts(msAgo), message: { role: 'user', content: text } })
const done = (id: string, msAgo = 1000) => userText(`<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`, msAgo)
const assistantQuote = (text: string) => JSON.stringify({ type: 'assistant', timestamp: ts(1000), message: { content: [{ type: 'text', text }] } })

let dir: string
const write = (lines: string[]) => {
  const p = join(dir, 't.jsonl')
  writeFileSync(p, lines.join('\n') + '\n')
  return p
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deepstack-bg-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('pendingBackgroundTasks', () => {
  it('finds each kind of background task until it reports back', () => {
    const p = write([
      toolResult('Command did not complete within its 120s timeout and was moved to the background (ID: bo73yef9p). Output is being written to: /tmp/x'),
      toolResult('Command running in background with ID: bldb7zjsy. Output is being written to: /tmp/y'),
      toolResult('Async agent launched successfully. (internal)\nagentId: a820931e165b56b48 (internal ID)'),
      userText('<bash-stdout>Command did not complete within its 120s timeout and was moved to the background (ID: b03vzj6gd). Output…</bash-stdout><bash-stderr></bash-stderr>'),
      done('bldb7zjsy')
    ])
    expect(pendingBackgroundTasks(p, NOW).sort()).toEqual(['a820931e165b56b48', 'b03vzj6gd', 'bo73yef9p'])
  })

  it('is empty once everything reported back', () => {
    const p = write([toolResult('Command running in background with ID: bldb7zjsy. Output'), done('bldb7zjsy')])
    expect(pendingBackgroundTasks(p, NOW)).toEqual([])
  })

  it('ignores the same words quoted in conversation or in other output', () => {
    const p = write([
      assistantQuote('Command running in background with ID: bxxxxxxxx'),
      toolResult('grep output:\nmoved to the background (ID: byyyyyyyy)'),
      userText('why did "Command running in background with ID: bzzzzzzzz" steal my focus?')
    ])
    expect(pendingBackgroundTasks(p, NOW)).toEqual([])
  })

  it('stops counting a task that never reported back after a while', () => {
    const p = write([toolResult('Command running in background with ID: bold00000. Output', BACKGROUND_MAX_AGE_MS + 1000)])
    expect(pendingBackgroundTasks(p, NOW)).toEqual([])
  })

  it('treats a missing transcript as nothing pending', () => {
    expect(pendingBackgroundTasks(join(dir, 'nope.jsonl'), NOW)).toEqual([])
  })
})

describe('findTranscript', () => {
  it('looks in the launch directory folder, then anywhere by session id', () => {
    const projects = join(dir, 'projects')
    mkdirSync(join(projects, '-Users-me-Projects-my-app'), { recursive: true })
    mkdirSync(join(projects, '-elsewhere'), { recursive: true })
    writeFileSync(join(projects, '-Users-me-Projects-my-app', 'sid1.jsonl'), '')
    writeFileSync(join(projects, '-elsewhere', 'sid2.jsonl'), '')
    expect(findTranscript(projects, 'sid1', '/Users/me/Projects/my.app')).toBe(join(projects, '-Users-me-Projects-my-app', 'sid1.jsonl'))
    expect(findTranscript(projects, 'sid2', '/Users/me/Projects/my.app/sub')).toBe(join(projects, '-elsewhere', 'sid2.jsonl'))
    expect(findTranscript(projects, 'sid3', '/x')).toBeNull()
  })
})
