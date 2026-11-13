// Bundles the server, pty host and optional Electron viewer. The UI is built by Vite.
import { build, context } from 'esbuild'

const watch = process.argv.includes('--watch')
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // Native / runtime-resolved packages stay in node_modules.
  external: ['node-pty', 'electron', '@xterm/headless', '@xterm/addon-serialize', 'ws']
}

const targets = [
  { ...common, entryPoints: { index: 'src/server/index.ts', ptyHost: 'src/ptyhost/index.ts' }, outdir: 'out/server' },
  { ...common, entryPoints: { main: 'src/electron/main.ts' }, outdir: 'out/electron' }
]

if (watch) {
  for (const t of targets) await (await context(t)).watch()
} else {
  await Promise.all(targets.map((t) => build(t)))
}
