// Curated vivid session colors, in the order new sessions get them. Ranked for the green
// phosphor theme: lime first, then the classic CRT phosphors (cyan, amber, green); alarm-red
// last since it reads as an error. Neighbours in this list are always far apart in hue, so a stack built
// in order never puts two look-alikes next to each other.
export const SESSION_COLORS = [
  '#a3e635', // lime
  '#22d3ee', // cyan
  '#fbbf24', // amber
  '#4ade80', // phosphor green
  '#a78bfa', // violet
  '#fb923c', // orange
  '#60a5fa', // blue
  '#f472b6', // hot pink
  '#2dd4bf', // teal
  '#e879f9', // fuchsia
  '#facc15', // yellow
  '#f87171' // coral
]

/** Hues closer than this read as "the same colour" side by side. */
const MIN_NEIGHBOUR_HUE = 40

function hue(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 0
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return (h * 60 + 360) % 360
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b)
  return Math.min(d, 360 - d)
}

/**
 * Colour for a new session: the best-ranked colour not already in use that doesn't look like
 * the session it lands next to (`neighbour`, the one above it in the stack). Once every colour
 * is taken, colours repeat in rank order, still avoiding the neighbour's hue.
 */
export function pickColor(used: string[], neighbour?: string): string {
  const okBeside = (c: string) => !neighbour || hueDistance(hue(c), hue(neighbour)) >= MIN_NEIGHBOUR_HUE
  const unused = SESSION_COLORS.filter((c) => !used.includes(c))
  return unused.find(okBeside) ?? unused[0] ?? SESSION_COLORS.find(okBeside) ?? SESSION_COLORS[0]
}
