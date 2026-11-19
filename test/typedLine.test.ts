import { describe, expect, it } from 'vitest'
import { feedLine, isSlashCommand } from '../src/server/typedLine'

describe('feedLine', () => {
  it('tracks typing, backspace, ctrl-U, and reports submitted lines', () => {
    let r = feedLine('', '/contx\x7fext')
    expect(r).toEqual({ line: '/context', submitted: [] })
    r = feedLine(r.line, '\r')
    expect(r.submitted).toEqual(['/context'])
    expect(feedLine('junk', '\x15/model\r').submitted).toEqual(['/model'])
  })

  it('skips arrow keys and takes a paste whole', () => {
    expect(feedLine('', '\x1b[A/a\x1bOB').line).toBe('/a')
    expect(feedLine('', '\x1b[200~two\nlines\x1b[201~\r').submitted).toEqual(['two lines'])
  })
})

describe('isSlashCommand', () => {
  it('knows a command from a prompt that starts with a path', () => {
    expect(isSlashCommand('/context')).toBe(true)
    expect(isSlashCommand('  /rs-gitlab:create-mr draft ')).toBe(true)
    expect(isSlashCommand('/tmp/log.txt has the error')).toBe(false)
    expect(isSlashCommand('fix /context')).toBe(false)
  })
})
