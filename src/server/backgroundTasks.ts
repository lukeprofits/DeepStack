import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'

// Claude can go quiet while work it started keeps running in the background (a command that
// outlived its timeout, a run_in_background command, an async agent). It isn't waiting on the
// human then: it picks up by itself when the task reports back. Claude Code doesn't tell hooks
// about this, but its transcript records both ends, so we read the tail of that.

/** Only the end of the transcript is read (they grow to tens of MB). */
const TAIL_BYTES = 2 * 1024 * 1024
/** A task that never reported back (lost in a restart, say) stops counting after this. */
export const BACKGROUND_MAX_AGE_MS = 2 * 60 * 60 * 1000

// How Claude Code words the start of each kind of background task, and where its ID is.
const STARTS: RegExp[] = [
  /^Command did not complete within .*? moved to the background \(ID: ([a-z0-9]+)\)/,
  /^Command running in background with ID: ([a-z0-9]+)/,
  /^Async agent launched successfully[\s\S]*?agentId: ([a-z0-9]+)/,
  // A `!` shell command typed by the human that outlived its timeout.
  /^<bash-stdout>Command did not complete within .*? moved to the background \(ID: ([a-z0-9]+)\)/
]
const END = /^<task-notification>\s*<task-id>([a-z0-9]+)<\/task-id>/

type Entry = { type?: string; timestamp?: string; message?: { content?: unknown }; content?: unknown }

/** The text a transcript entry carries where a task start or end could be: tool results and plain user text. */
function texts(e: Entry): string[] {
  const out: string[] = []
  const c = e.type === 'queue-operation' ? e.content : e.message?.content
  if (typeof c === 'string') out.push(c)
  else if (Array.isArray(c)) {
    for (const block of c as { type?: string; content?: unknown }[]) {
      if (block?.type !== 'tool_result') continue
      if (typeof block.content === 'string') out.push(block.content)
      else if (Array.isArray(block.content)) for (const b of block.content as { text?: unknown }[]) if (typeof b?.text === 'string') out.push(b.text)
    }
  }
  return out
}

function readTail(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    // Starting mid-file: drop the partial first line.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(fd)
  }
}

/** IDs of background tasks started (recently) in this transcript that haven't reported back. */
export function pendingBackgroundTasks(path: string, now = Date.now()): string[] {
  let text: string
  try {
    text = readTail(path)
  } catch {
    return []
  }
  const open = new Map<string, number>()
  for (const line of text.split('\n')) {
    // Cheap pre-filter before parsing: most lines can't matter.
    if (!line.includes('background') && !line.includes('Async agent') && !line.includes('task-notification')) continue
    let e: Entry
    try {
      e = JSON.parse(line) as Entry
    } catch {
      continue
    }
    if (e.type !== 'user' && e.type !== 'queue-operation') continue
    const at = e.timestamp ? Date.parse(e.timestamp) : now
    for (const t of texts(e)) {
      const end = END.exec(t)
      if (end) {
        open.delete(end[1])
        continue
      }
      if (e.type !== 'user') continue
      for (const re of STARTS) {
        const m = re.exec(t)
        if (m) open.set(m[1], at)
      }
    }
  }
  return [...open].filter(([, at]) => now - at < BACKGROUND_MAX_AGE_MS).map(([id]) => id)
}

/**
 * Where Claude keeps a session's transcript, when no hook has told us: its project folder is the
 * launch directory with every non-alphanumeric character turned into "-", but that directory
 * may not be the shell's current one, so fall back to looking for the file by session id.
 */
export function findTranscript(projectsDir: string, sid: string, cwd: string): string | null {
  const guess = join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`)
  if (existsSync(guess)) return guess
  try {
    for (const d of readdirSync(projectsDir)) {
      const p = join(projectsDir, d, `${sid}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    /* no projects dir */
  }
  return null
}
