// Message contracts: server <-> pty host (child process IPC) and server <-> browser (WebSocket).

export interface SpawnSpec {
  id: string
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  scrollback: number
  historyPath: string
  /** Typed into the shell once it has started (e.g. "claude --resume <id>\r"). */
  initialInput?: string
}

/** Foreground program of a session's shell, polled by the host. */
export interface ProcInfo {
  cwd?: string
  /** null when the shell itself is in the foreground. */
  fg: { pid: number; comm: string; args: string } | null
}

/** server -> pty host */
export type HostControl =
  | { t: 'spawn'; spec: SpawnSpec }
  | { t: 'kill'; id: string }
  | { t: 'forget'; id: string }
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; cols: number; rows: number; activeId: string | null }
  /** Sessions some browser is currently viewing (they answer terminal queries themselves). */
  | { t: 'watched'; ids: string[] }
  | { t: 'pause'; id: string; paused: boolean }
  /** Resend every mini frame (a browser just connected). */
  | { t: 'refreshMinis' }
  | { t: 'attach'; reqId: number; id: string; scrollback: number }
  | { t: 'history'; reqId: number; id: string; lines: number }
  | { t: 'snapshot'; reqId: number; id: string }

/** pty host -> server */
export type HostEvent =
  | { t: 'ready' }
  | { t: 'spawned'; id: string; pid: number }
  | { t: 'exit'; id: string; code: number; signal: number; uptimeMs: number }
  | { t: 'title'; id: string; title: string }
  | { t: 'proc'; id: string; info: ProcInfo }
  | { t: 'data'; id: string; seq: number; d: string }
  | { t: 'mini'; id: string; cols: number; rows: number; cells: Uint32Array }
  | { t: 'attached'; reqId: number; id: string; seq: number; ansi: string; live: boolean }
  | { t: 'history'; reqId: number; id: string; seq: number; ansi: string; lines: number; complete: boolean }
  | { t: 'snapshot'; reqId: number; id: string; snapshot: Snapshot | null }
  | { t: 'error'; id?: string; message: string }

/** Persisted last-known screen, used to draw dormant/errored minis. */
export interface Snapshot {
  cols: number
  rows: number
  /** Base64 of the mini cell Uint32Array (see miniCodec). */
  cells: string
  takenAt: number
}

/** browser -> server (JSON text frames) */
export type ClientMsg =
  | { t: 'rpc'; rid: number; method: 'getState' | 'intent' | 'getSnapshot'; arg?: unknown }
  | { t: 'input'; id: string; data: string }
  | { t: 'attach'; id: string; scrollback: number }
  | { t: 'detach'; id: string }
  | { t: 'history'; id: string; lines: number }

/** server -> browser (JSON text frames; mini frames are binary, see miniCodec.packMini) */
export type ServerMsg =
  | { t: 'rpc'; rid: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'state'; state: unknown }
  | { t: 'sendOff'; id: string; target: string; ms: number }
  | { t: 'snap'; id: string; from: string | null }
  | { t: 'data'; id: string; seq: number; d: string }
  | { t: 'attached'; id: string; seq: number; ansi: string; live: boolean }
  | { t: 'history'; id: string; seq: number; ansi: string; lines: number; complete: boolean }
  | { t: 'bye' }
