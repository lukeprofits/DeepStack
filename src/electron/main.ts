// Optional standalone window ("Launch standalone" setting). Just a viewer for the Stack
// server's UI; terminals live in the server, so closing this window loses nothing.
import { app, BrowserWindow, screen, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const url = process.argv.find((a) => a.startsWith('http://127.0.0.1:'))
if (!url) app.exit(1)

app.setName('Stack')
// The DeepStack logo as the Dock / taskbar icon (built into out/renderer from public/).
const icon = join(__dirname, '..', 'renderer', 'icon-512.png')
const boundsFile = () => join(app.getPath('userData'), 'window.json')

function loadBounds(): Electron.Rectangle | null {
  try {
    return JSON.parse(readFileSync(boundsFile(), 'utf8'))
  } catch {
    return null
  }
}

void app.whenReady().then(() => {
  app.dock?.setIcon(icon)
  const area = screen.getPrimaryDisplay().workAreaSize
  const saved = loadBounds()
  const win = new BrowserWindow({
    width: saved?.width ?? Math.min(1600, area.width),
    height: saved?.height ?? Math.min(1000, area.height),
    x: saved?.x,
    y: saved?.y,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: '#0d0e10',
    title: 'Stack',
    icon,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  const origin = new URL(url!).origin
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin !== origin) e.preventDefault()
  })
  win.on('close', () => {
    try {
      writeFileSync(boundsFile(), JSON.stringify(win.getBounds()))
    } catch {
      /* ignore */
    }
  })
  void win.loadURL(url!)
})

app.on('window-all-closed', () => app.quit())
