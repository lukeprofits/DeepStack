/**
 * The force field around a window swinging on its hinge (90s Hacker): Stage writes each
 * window's on-screen box and strength every frame of the swing; the backdrop (fx/matrix.ts)
 * ripples and tears itself around those boxes. Index 0 = incoming window, 1 = outgoing.
 */
export interface Field {
  x0: number
  y0: number
  x1: number
  y1: number
  /** 0..1; 0 = no field. */
  s: number
}

export const fxField: [Field, Field] = [
  { x0: 0, y0: 0, x1: 0, y1: 0, s: 0 },
  { x0: 0, y0: 0, x1: 0, y1: 0, s: 0 }
]
