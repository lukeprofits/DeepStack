import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic } from './persist'

export interface HookEvent {
  sid: string
  name: string
  payload: Record<string, unknown>
}

const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'PermissionRequest', 'Stop', 'StopFailure']

/** Marker that identifies our entries in ~/.claude/settings.json. */
const MARKER = 'STACK_SOCK'

/**
 * Socket lives under /tmp because macOS caps unix socket paths at 104 bytes, which the
 * Application Support path can exceed. The directory is 0700 and every request must carry
 * a known session id, so other users can't reach it and stray processes can't spoof state.
 */
export function hookSocketPath(): string {
  return join('/tmp', `stack-${process.getuid?.() ?? 'user'}`, 'h.sock')
}

/**
 * Does nothing unless run inside a DeepStack terminal ($STACK_SOCK set). Prints nothing (stdout
 * from SessionStart/UserPromptSubmit hooks is injected into Claude's context) and always
 * exits 0 so a stopped DeepStack never blocks Claude. Command hooks, because http hooks don't
 * fire for SessionStart.
 */
export function hookCommand(ev: string): string {
  return (
    `[ -n "$${MARKER}" ] && curl -s -m 2 --unix-socket "$${MARKER}" --data-binary @- ` +
    `"http://stack/hook?sid=$STACK_SID&ev=${ev}" >/dev/null 2>&1; exit 0`
  )
}

type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }
type ClaudeSettings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown }

export const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json')

function readClaudeSettings(): ClaudeSettings | null {
  if (!existsSync(CLAUDE_SETTINGS)) return {}
  try {
    return JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8')) as ClaudeSettings
  } catch {
    // Never rewrite a settings file we can't parse.
    return null
  }
}

const isOurs = (e: HookEntry) => e.hooks?.some((h) => h.command?.includes(MARKER) && h.command.includes('stack/hook'))

export function globalHooksInstalled(): boolean {
  const s = readClaudeSettings()
  return !!s?.hooks && EVENTS.every((ev) => s.hooks?.[ev]?.some(isOurs))
}

export function installGlobalHooks(): { ok: boolean; error?: string } {
  const s = readClaudeSettings()
  if (!s) return { ok: false, error: '~/.claude/settings.json is not valid JSON; left it untouched.' }
  const hooks = { ...(s.hooks ?? {}) }
  for (const ev of EVENTS) {
    const kept = (hooks[ev] ?? []).filter((e) => !isOurs(e))
    hooks[ev] = [...kept, { hooks: [{ type: 'command', command: hookCommand(ev), timeout: 5 }] }]
  }
  writeJsonAtomic(CLAUDE_SETTINGS, { ...s, hooks })
  return { ok: true }
}

export function removeGlobalHooks(): { ok: boolean; error?: string } {
  const s = readClaudeSettings()
  if (!s) return { ok: false, error: '~/.claude/settings.json is not valid JSON; left it untouched.' }
  if (!s.hooks) return { ok: true }
  const hooks: Record<string, HookEntry[]> = {}
  for (const [ev, entries] of Object.entries(s.hooks)) {
    const kept = entries.filter((e) => !isOurs(e))
    if (kept.length) hooks[ev] = kept
  }
  const next: ClaudeSettings = { ...s, hooks }
  if (Object.keys(hooks).length === 0) delete next.hooks
  writeJsonAtomic(CLAUDE_SETTINGS, next)
  return { ok: true }
}

/** Same hooks as a standalone file, passed with --settings when the global ones aren't installed. */
export function writeLocalHookSettings(path: string): void {
  const hooks: Record<string, HookEntry[]> = {}
  for (const ev of EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: hookCommand(ev), timeout: 5 }] }]
  writeJsonAtomic(path, { hooks })
}

export function hooksDisabledByUser(): boolean {
  return !!readClaudeSettings()?.disableAllHooks
}

export function startHookServer(socketPath: string, onEvent: (e: HookEvent) => void): Server {
  const dir = join(socketPath, '..')
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o700)
  rmSync(socketPath, { force: true })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stack')
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => {
      if (body.length < 1_000_000) body += c
    })
    req.on('end', () => {
      res.writeHead(200).end()
      const sid = url.searchParams.get('sid')
      const name = url.searchParams.get('ev')
      if (!sid || !name) return
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(body)
      } catch {
        /* keep empty */
      }
      try {
        onEvent({ sid, name, payload })
      } catch (e) {
        console.error('hook handler failed', e)
      }
    })
  })
  server.on('error', (e) => console.error('hook server error', e))
  server.listen(socketPath, () => chmodSync(socketPath, 0o600))
  return server
}
