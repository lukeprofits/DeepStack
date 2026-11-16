import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { liftCurtain } from './lib/curtain'

createRoot(document.getElementById('root')!).render(<App />)
// Never leave the curtain down if something stalls (server unreachable, an error).
window.setTimeout(() => liftCurtain(), 6000)
