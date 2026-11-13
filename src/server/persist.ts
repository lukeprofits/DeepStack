import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** Write via tmp + fsync + rename so a crash mid-write never leaves a torn file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(data, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`)
    } catch {
      /* backup is best-effort */
    }
  }
  renameSync(tmp, path)
}

export interface ReadResult<T> {
  value: T | null
  /** Set when the main file was unreadable and we fell back to the backup (or nothing). */
  warning?: string
}

export function readJsonSafe<T>(path: string, validate: (v: unknown) => v is T): ReadResult<T> {
  const tryRead = (p: string): T | null => {
    if (!existsSync(p)) return null
    try {
      const v = JSON.parse(readFileSync(p, 'utf8'))
      return validate(v) ? v : null
    } catch {
      return null
    }
  }
  const main = tryRead(path)
  if (main) return { value: main }
  const bak = tryRead(`${path}.bak`)
  if (bak) return { value: bak, warning: 'State file was unreadable; restored from backup.' }
  if (existsSync(path)) return { value: null, warning: 'State file was unreadable and no backup was usable; starting fresh.' }
  return { value: null }
}

/** Coalesce frequent saves into one write after `ms` of quiet. */
export function debounced(fn: () => void, ms: number): { (): void; flush(): void } {
  let t: NodeJS.Timeout | null = null
  const run = () => {
    if (t) clearTimeout(t)
    t = setTimeout(() => {
      t = null
      fn()
    }, ms)
  }
  run.flush = () => {
    if (t) {
      clearTimeout(t)
      t = null
      fn()
    }
  }
  return run
}
