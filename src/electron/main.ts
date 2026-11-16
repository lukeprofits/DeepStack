// Optional standalone window ("Launch standalone" setting). Just a viewer for the DeepStack
// server's UI; terminals live in the server, so closing this window loses nothing.
import { app, BrowserWindow, screen, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const url = process.argv.find((a) => a.startsWith('http://127.0.0.1:'))
if (!url) app.exit(1)

app.setName('DeepStack')
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
  const display = screen.getPrimaryDisplay()
  const area = display.workAreaSize
  const saved = loadBounds()
  const windowed = {
    width: saved?.width ?? Math.min(1600, area.width),
    height: saved?.height ?? Math.min(1000, area.height),
    x: saved?.x,
    y: saved?.y
  }
  // Opens already covering the screen and stays hidden until its first frame is ready, so the
  // launch is black, then the boot reveal; no macOS fullscreen zoom from a smaller window.
  const mac = process.platform === 'darwin'
  const win = new BrowserWindow({
    ...(mac ? display.bounds : windowed),
    show: false,
    fullscreen: !mac,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: '#010402',
    title: 'DeepStack',
    icon,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  if (mac) win.setSimpleFullScreen(true)
  win.once('ready-to-show', () => win.show())
  // ⌃⌘F leaves (or re-enters) fullscreen; leaving restores the saved window size.
  win.webContents.on('before-input-event', (e, input) => {
    if (!mac || input.type !== 'keyDown' || !input.meta || !input.control || input.key.toLowerCase() !== 'f') return
    e.preventDefault()
    const on = !win.isSimpleFullScreen()
    win.setSimpleFullScreen(on)
    if (!on && windowed.x !== undefined && windowed.y !== undefined) win.setBounds(windowed as Electron.Rectangle)
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
    // Remember the windowed size only; the fullscreen frame is always the screen.
    if (win.isSimpleFullScreen() || win.isFullScreen()) return
    try {
      writeFileSync(boundsFile(), JSON.stringify(win.getBounds()))
    } catch {
      /* ignore */
    }
  })
  void win.loadURL(url!)
})

app.on('window-all-closed', () => app.quit())
