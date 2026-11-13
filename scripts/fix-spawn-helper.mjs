// node-pty's prebuilt spawn-helper sometimes loses its exec bit in npm installs,
// which makes every spawn fail with "posix_spawnp failed".
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const prebuilds = join('node_modules', 'node-pty', 'prebuilds')
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
const built = join('node_modules', 'node-pty', 'build', 'Release', 'spawn-helper')
if (existsSync(built)) chmodSync(built, 0o755)
