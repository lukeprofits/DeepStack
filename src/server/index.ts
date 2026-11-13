// DeepStack server: owns every terminal (through the pty host child process) and serves the UI
// to a browser tab on 127.0.0.1. Closing the tab loses nothing; sessions live here.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { APP_NAME } from '../shared/appName'
import { Controller } from './controller'
import { hookSocketPath, startHookServer, writeLocalHookSettings } from './hookServer'
import { writeJsonAtomic } from './persist'
import { PtyHostManager } from './ptyHostManager'
import { WebServer } from './web'

const DEFAULT_PORT = 4777

process.on('uncaughtException', (e) => console.error('uncaught in server', e))
process.on('unhandledRejection', (e) => console.error('unhandled rejection in server', e))

function dataDirFor(name: string): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name)
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), name.toLowerCase())
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The app was called "Stack" before DeepStack. Move its data (sessions, settings, token,
 * snapshots, history) to the new folder on first start, unless an old server is still
 * running from it.
 */
function migrateLegacyDataDir(dir: string): void {
  const legacy = dataDirFor('Stack')
  if (existsSync(dir) || !existsSync(legacy)) return
  try {
    const running = JSON.parse(readFileSync(join(legacy, 'server.json'), 'utf8')).pid
    if (pidAlive(running)) {
      console.error(`An older Stack server (pid ${running}) is still running from ${legacy}. Quit it, then start ${APP_NAME} again to carry your sessions over.`)
      return
    }
  } catch {
    /* no server.json: nothing running */
  }
  renameSync(legacy, dir)
  console.log(`Moved your sessions from ${legacy} to ${dir}`)
}

const dir = process.env.STACK_DATA_DIR ? resolve(process.env.STACK_DATA_DIR) : dataDirFor(APP_NAME)
if (!process.env.STACK_DATA_DIR) migrateLegacyDataDir(dir)
mkdirSync(dir, { recursive: true })
const serverFile = join(dir, 'server.json')
const tokenFile = join(dir, 'token.json')

const args = process.argv.slice(2)
const noOpen = args.includes('--no-open')
const forceStandalone = args.includes('--standalone')
const forceBrowser = args.includes('--browser')

/** A stable token so a bookmarked tab keeps working across restarts. */
function loadToken(): string {
  try {
    const t = JSON.parse(readFileSync(tokenFile, 'utf8')).token
    if (typeof t === 'string' && t.length >= 32) return t
  } catch {
    /* create below */
  }
  const token = randomBytes(24).toString('hex')
  writeJsonAtomic(tokenFile, { token })
  return token
}

function openUi(url: string, standalone: boolean): void {
  if (noOpen) return
  if (standalone) {
    try {
      // In plain Node, require('electron') resolves to the path of the Electron binary.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as unknown as string
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(electron, [join(__dirname, '..', 'electron', 'main.js'), url], { detached: true, stdio: 'ignore', env })
      child.unref()
      return
    } catch (e) {
      console.error('could not launch standalone window, opening a browser tab instead', e)
    }
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref()
}

function readStandaloneSetting(): boolean {
  try {
    return !!JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).settings?.standalone
  } catch {
    return false
  }
}

async function alreadyRunning(): Promise<{ port: number } | null> {
  if (!existsSync(serverFile)) return null
  try {
    const { port, pid } = JSON.parse(readFileSync(serverFile, 'utf8'))
    process.kill(pid, 0)
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    if ((await res.text()) === 'stack') return { port }
  } catch {
    /* stale */
  }
  return null
}

async function main(): Promise<void> {
  const token = loadToken()
  const standalone = forceStandalone || (!forceBrowser && readStandaloneSetting())

  const running = await alreadyRunning()
  if (running) {
    const url = `http://127.0.0.1:${running.port}/#token=${token}`
    console.log(`${APP_NAME} is already running at http://127.0.0.1:${running.port}`)
    openUi(url, standalone)
    return
  }

  const paths = {
    state: join(dir, 'state.json'),
    snapshots: join(dir, 'snapshots'),
    history: join(dir, 'history'),
    hooksFile: join(dir, 'claude-hooks.json'),
    socket: hookSocketPath()
  }
  writeLocalHookSettings(paths.hooksFile)

  let web: WebServer
  let quitting = false

  const host = new PtyHostManager(
    (ev) => {
      if (ev.t === 'ready') {
        controller.restoreOnce()
        web?.resendWatched()
      }
      controller.onHostEvent(ev)
      web?.onHostEvent(ev)
    },
    () => controller.onHostCrash()
  )

  const quit = async () => {
    if (quitting) return
    quitting = true
    await controller.shutdown()
    web.closeAll()
    host.stop()
    rmSync(serverFile, { force: true })
    setTimeout(() => process.exit(0), 200)
  }

  const controller = new Controller({
    paths,
    host: (m) => host.send(m),
    broadcast: (state) => web?.broadcast({ t: 'state', state }),
    sendOff: (id, target, ms) => web.broadcast({ t: 'sendOff', id, target, ms }),
    snap: (id, from) => web.broadcast({ t: 'snap', id, from }),
    quit: () => void quit(),
    shell: process.env.SHELL || '/bin/zsh',
    home: homedir()
  })

  web = new WebServer({
    staticDir: resolve(__dirname, '..', 'renderer'),
    token,
    host: (m) => host.send(m),
    rpc: (method, arg) => {
      if (method === 'getState') return controller.state
      if (method === 'getSnapshot') return controller.getSnapshot(String(arg))
      if (method === 'intent') return controller.intent(arg as never)
      throw new Error(`unknown method ${method}`)
    },
    onInput: (id) => controller.onInput(id),
    getState: () => controller.state
  })

  let port: number
  try {
    port = await web.listen(Number(process.env.STACK_PORT) || DEFAULT_PORT)
  } catch {
    port = await web.listen(0)
  }
  writeJsonAtomic(serverFile, { port, pid: process.pid })

  startHookServer(paths.socket, (e) => controller.onHook(e))
  host.start()

  const url = `http://127.0.0.1:${port}/#token=${token}`
  console.log(`${APP_NAME} running at http://127.0.0.1:${port}  (Ctrl+C to stop)`)
  openUi(url, standalone)

  process.on('SIGINT', () => void quit())
  process.on('SIGTERM', () => void quit())
}

void main()
