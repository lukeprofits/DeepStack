// Rebuilds on change and restarts the server. UI changes only need a browser reload;
// server changes restart the server (and its terminals).
import { spawn } from 'node:child_process'

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: false })

const children = [
  run('node', ['scripts/build.mjs', '--watch']),
  run('npx', ['vite', 'build', '--watch', '--logLevel', 'warn']),
  // Give the first builds a moment before the server starts watching its output.
  setTimeout(() => children.push(run('node', ['--watch-path=out/server', 'out/server/index.js', ...process.argv.slice(2)])), 2500)
]

const stop = () => {
  for (const c of children) if (c && typeof c.kill === 'function') c.kill('SIGINT')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
