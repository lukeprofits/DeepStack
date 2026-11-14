// Puts `deepstack` on your PATH: symlinks bin/deepstack into ~/.local/bin (or /usr/local/bin
// when that's on PATH and ~/.local/bin isn't).
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const target = resolve('bin', 'deepstack')
chmodSync(target, 0o755)
const path = (process.env.PATH ?? '').split(delimiter)
const local = join(homedir(), '.local', 'bin')
const dir = !path.includes(local) && path.includes('/usr/local/bin') ? '/usr/local/bin' : local
const link = join(dir, 'deepstack')

mkdirSync(dir, { recursive: true })
let exists = false
try {
  exists = !!lstatSync(link)
} catch {}
if (exists) {
  const isOurs = lstatSync(link).isSymbolicLink() && resolve(dir, readlinkSync(link)) === target
  if (!isOurs) {
    console.error(`${link} already exists and isn't DeepStack's. Remove it first if you want to replace it.`)
    process.exit(1)
  }
  unlinkSync(link)
}
symlinkSync(target, link)
console.log(`Linked ${link} -> ${target}`)
if (!path.includes(dir)) console.log(`Add ${dir} to your PATH to use it:  export PATH="${dir}:$PATH"`)
else console.log('Try it: deepstack help')
