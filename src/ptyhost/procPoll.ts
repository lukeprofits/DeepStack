import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import type { ProcInfo } from '../shared/protocol'

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 4000 }, (_err, stdout) => resolve(stdout ?? ''))
  })
}

export function isClaude(comm: string, args: string): boolean {
  if (basename(comm) === 'claude') return true
  // npm installs run as "node /path/to/claude ..."
  const [first, second] = args.trim().split(/\s+/)
  return basename(first ?? '') === 'claude' || (basename(first ?? '') === 'node' && /(^|\/)claude(\.js)?$/.test(second ?? ''))
}

/**
 * One `ps` and one `lsof` for all sessions: which program each shell has in the foreground
 * and the shell's working directory. Used to remember what to resume after a restart.
 */
export async function pollProcs(shellPids: Map<string, number>): Promise<Map<string, ProcInfo>> {
  const out = new Map<string, ProcInfo>()
  if (shellPids.size === 0) return out

  const ps = await run('ps', ['-axo', 'pid=,tpgid=,comm=,args='])
  const rows = new Map<number, { tpgid: number; comm: string; args: string }>()
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m) rows.set(Number(m[1]), { tpgid: Number(m[2]), comm: m[3], args: m[4] })
  }

  const pids = [...shellPids.values()]
  const lsof = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')])
  const cwds = new Map<number, string>()
  let pid = 0
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1))
  }

  for (const [id, shellPid] of shellPids) {
    const shell = rows.get(shellPid)
    if (!shell) continue
    let fg: ProcInfo['fg'] = null
    if (shell.tpgid > 0 && shell.tpgid !== shellPid) {
      const leader = rows.get(shell.tpgid)
      if (leader) fg = { pid: shell.tpgid, comm: leader.comm, args: leader.args }
    }
    out.set(id, { cwd: cwds.get(shellPid), fg })
  }
  return out
}
