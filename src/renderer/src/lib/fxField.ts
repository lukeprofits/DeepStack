/**
 * The force field around a window swinging on its hinge (Hacker): Stage writes each
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

/**
 * The pit a thrown window falls into (Hacker): Stage writes the stage's box (the pit is seen
 * down through it) and the pit's strength each frame of the fall; the backdrop draws it and
 * eases it shut after.
 */
export const fxPit: Field = { x0: 0, y0: 0, x1: 0, y1: 0, s: 0 }

/**
 * The thrown window blowing up far down the pit (Hacker): Stage writes where (its centre), how
 * big (half its on-screen diagonal), its colour and when, once per throw; the backdrop draws it.
 */
export const fxBurst: { x: number; y: number; r: number; corners: [number, number][]; color: string; at: number } = { x: 0, y: 0, r: 0, corners: [], color: '', at: 0 }

/** The incoming window's lasso while it catches (Hacker): its line, dot first, and the energy's strength. */
export const fxLasso: { pts: [number, number][] | null; s: number } = { pts: null, s: 0 }
