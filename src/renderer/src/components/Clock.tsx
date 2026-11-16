import { useEffect, useState } from 'react'

/** "4:00pm": the hour without a leading zero, minutes, lowercase am/pm. */
function format(d: Date): string {
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h % 12 || 12}:${m}${h < 12 ? 'am' : 'pm'}`
}

/** The current time, ticking over exactly on the minute. */
export function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const d = new Date()
      setNow(d)
      timer = window.setTimeout(tick, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50)
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <span className="header-clock" title={now.toLocaleString()}>
      {format(now)}
    </span>
  )
}
