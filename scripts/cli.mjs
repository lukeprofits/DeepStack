// The `deepstack` command: start / open, stop, restart, update. Run through bin/deepstack,
// which has already cd'd into the repo.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

const NAME = 'DeepStack'
const REPO = process.cwd()

const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  console.error(`${NAME} needs Node 22 or newer (this is Node ${process.versions.node}).`)
  process.exit(1)
}

// Same location the server uses (src/server/index.ts).
function dataDir() {
  if (process.env.STACK_DATA_DIR) return resolve(process.env.STACK_DATA_DIR)
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', NAME)
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), NAME.toLowerCase())
}

function running() {
  try {
    const { pid, port } = JSON.parse(readFileSync(join(dataDir(), 'server.json'), 'utf8'))
    process.kill(pid, 0)
    return { pid, port }
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Set inside a DeepStack terminal: stopping the server would close the terminal we run in. */
const insideDeepStack = !!process.env.STACK_SID

/** Our environment minus a DeepStack session's own variables, for processes that outlive it. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.STACK_SID
  delete env.STACK_SOCK
  return env
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    console.error(`\n${NAME}: \`${cmd} ${args.join(' ')}\` failed.`)
    process.exit(r.status ?? 1)
  }
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

function build() {
  run('npm', ['run', 'build', '--silent'])
}

/** Start the server in the background; it opens a browser tab unless `open` is false. */
async function start({ open = true } = {}) {
  const r = running()
  if (r) {
    if (open) run('node', ['out/server/index.js']) // prints "already running" and opens the tab
    else console.log(`${NAME} is running at http://127.0.0.1:${r.port}`)
    return
  }
  build()
  mkdirSync(dataDir(), { recursive: true })
  const log = openSync(join(dataDir(), 'server.log'), 'a')
  const child = spawn('node', ['out/server/index.js', ...(open ? [] : ['--no-open'])], {
    detached: true,
    stdio: ['ignore', log, log],
    env: cleanEnv()
  })
  child.unref()
  for (let i = 0; i < 50 && !running(); i++) await sleep(100)
  const now = running()
  if (!now) {
    console.error(`${NAME} didn't start. See ${join(dataDir(), 'server.log')}`)
    process.exit(1)
  }
  console.log(`${NAME} running at http://127.0.0.1:${now.port}  (stop with: deepstack stop)`)
}

async function stop() {
  const r = running()
  if (!r) {
    console.log(`${NAME} isn't running.`)
    return
  }
  process.kill(r.pid, 'SIGTERM')
  for (let i = 0; i < 100 && running(); i++) await sleep(100)
  if (running()) {
    console.error(`${NAME} (pid ${r.pid}) didn't stop within 10s.`)
    process.exit(1)
  }
  console.log(`${NAME} stopped.`)
}

async function restart() {
  if (insideDeepStack && running() && !process.env.DEEPSTACK_DETACHED) {
    // Hand off to a process in its own session, which survives this terminal closing.
    const log = openSync(join(dataDir(), 'server.log'), 'a')
    spawn('node', ['scripts/cli.mjs', 'restart'], {
      detached: true,
      stdio: ['ignore', log, log],
      env: cleanEnv({ DEEPSTACK_DETACHED: '1' })
    }).unref()
    console.log(`Restarting ${NAME}. This terminal closes and comes back fresh in a few seconds.`)
    return
  }
  const wasRunning = !!running()
  await stop()
  // An open tab reconnects by itself, so don't open another.
  await start({ open: !wasRunning })
}

const lockHash = () => (existsSync('package-lock.json') ? createHash('sha1').update(readFileSync('package-lock.json')).digest('hex') : '')

async function update() {
  if (!existsSync(join(REPO, '.git'))) {
    console.error(`${REPO} isn't a git checkout, so there's nothing to pull.`)
    process.exit(1)
  }
  if (git('status', '--porcelain', '--untracked-files=no')) {
    console.error(`You have local changes in ${REPO}. Commit or stash them, then run \`deepstack update\` again.`)
    process.exit(1)
  }
  const before = git('rev-parse', 'HEAD')
  const lock = lockHash()
  console.log(`Pulling the latest ${NAME}…`)
  run('git', ['pull', '--ff-only'])
  const after = git('rev-parse', 'HEAD')
  if (after === before) {
    console.log(`${NAME} is already up to date.`)
    return
  }
  console.log(`\n${git('log', '--oneline', '--no-decorate', `${before}..${after}`)}\n`)
  if (lockHash() !== lock) {
    // The lockfile pins public npm; say so explicitly so a machine-wide private registry doesn't apply.
    run('npm', ['install', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'])
  }
  build()
  if (!running()) {
    console.log(`Updated. Start it with: deepstack`)
    return
  }
  let yes = false
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const a = (await rl.question('Restart DeepStack now to use the update? Claude sessions resume; plain shells start fresh. [Y/n] ')).trim().toLowerCase()
    rl.close()
    yes = a === '' || a === 'y' || a === 'yes'
  }
  if (yes) await restart()
  else console.log('Updated. It takes effect after: deepstack restart')
}

const HELP = `Usage: deepstack [command]

  (none)    Start DeepStack, or open its tab if it's already running
  update    Pull the latest from GitHub, rebuild, and offer to restart
  restart   Restart the server (your open tab reconnects)
  stop      Stop the server and every terminal in it
  help      Show this`

const cmd = process.argv[2] ?? 'start'
const commands = { start, open: start, stop, restart, update }
if (commands[cmd]) await commands[cmd]()
else {
  console.log(HELP)
  if (!['help', '-h', '--help'].includes(cmd)) process.exit(1)
}
