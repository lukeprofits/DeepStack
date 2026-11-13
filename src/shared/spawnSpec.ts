import type { SpawnSpec } from './protocol'
import type { Program, SessionConfig } from './types'

export interface SpawnOptions {
  shell: string
  hookSocket: string
  cols: number
  rows: number
  scrollback: number
  historyPath: string
  baseEnv: Record<string, string | undefined>
  /** What to type once the shell is up (see resumeInput). */
  initialInput?: string
}

// Vars that must not leak from the environment DeepStack was launched in. CLAUDE_CODE_* in
// particular makes a child Claude think it is a sub-session and turns transcript saving off,
// which silently breaks --resume.
const STRIP = [/^CLAUDE/, /^ELECTRON_/, /^NODE_OPTIONS$/, /^VSCODE_/, /^TERM_PROGRAM/, /^ITERM_/, /^STACK_/]

export function cleanEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || STRIP.some((r) => r.test(k))) continue
    env[k] = v
  }
  return env
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** Every session is an interactive login shell, so the user's aliases, PATH and prompt apply. */
export function buildSpawnSpec(session: SessionConfig, o: SpawnOptions): SpawnSpec {
  const env = cleanEnv(o.baseEnv)
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.LANG = env.LANG || 'en_US.UTF-8'
  // oh-my-zsh's "Would you like to update?" prompt would swallow the resume command.
  env.DISABLE_AUTO_UPDATE = 'true'
  env.DISABLE_UPDATE_PROMPT = 'true'
  env.SHELL = o.shell
  // Hooks in ~/.claude/settings.json only report when these are set, i.e. inside DeepStack.
  env.STACK_SID = session.id
  env.STACK_SOCK = o.hookSocket
  return {
    id: session.id,
    file: o.shell,
    args: ['-l', '-i'],
    cwd: session.cwd,
    env,
    cols: o.cols,
    rows: o.rows,
    scrollback: o.scrollback,
    historyPath: o.historyPath,
    initialInput: o.initialInput
  }
}

// Claude flags worth carrying over on resume. Everything else (model etc.) normally comes from
// the user's own alias, and positional prompts must not be replayed.
const KEEP_BOOL = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose']
const KEEP_VALUE = ['--permission-mode', '--add-dir', '--agent']

export function claudeResumeFlags(args: string): string {
  const tokens = args.trim().split(/\s+/).slice(1)
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (KEEP_BOOL.includes(t)) out.push(t)
    else if (KEEP_VALUE.includes(t) && tokens[i + 1]) out.push(t, tokens[++i])
    else if (KEEP_VALUE.some((k) => t.startsWith(`${k}=`))) out.push(t)
  }
  return out.join(' ')
}

export interface ResumeOptions {
  /** DeepStack's own hooks file, passed when the global hooks aren't installed. */
  hooksPath?: string
  transcriptExists: (sid: string) => boolean
}

/**
 * Text to type into a freshly spawned shell to bring back what was running. Claude resumes
 * by session id (spends nothing until the first message); anything else is pre-typed
 * without Enter so the user decides whether to re-run it.
 */
export function resumeInput(session: SessionConfig, o: ResumeOptions): string | undefined {
  if (session.resumeOverride?.trim()) return `${session.resumeOverride.trim()}\r`
  const p: Program | undefined = session.program
  if (!p) return undefined
  if (p.kind === 'claude') {
    // No saved conversation yet (nothing was ever sent): start Claude fresh instead.
    const parts = p.sid && o.transcriptExists(p.sid) ? ['claude', '--resume', p.sid] : ['claude']
    if (p.flags) parts.push(p.flags)
    if (o.hooksPath) parts.push('--settings', shellQuote(o.hooksPath))
    return `${parts.join(' ')}\r`
  }
  return p.command
}
