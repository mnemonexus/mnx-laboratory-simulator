// Counting chambers (contract measurement.count, T2): a haemocytometer square holds a known
// volume, so the number of cells in it is Poisson-distributed around concentration × volume.
// A vital stain (trypan blue) enters only dead cells, so they look blue; without it, dead cells
// are counted with the living. The learner counts squares and works out the concentration.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents } from '../kernel/state.ts'
import { liquidVolume, meanLayer } from '../kernel/state.ts'
import type { Rng } from '../rng/rng.ts'

/** A Poisson draw from a generator (normal approximation for large means). */
export function poissonFrom(rng: Rng, mean: number): number {
  if (!(mean > 0)) return 0
  if (mean > 50) return Math.max(0, Math.round(mean + Math.sqrt(mean) * rng.normal()))
  const l = Math.exp(-mean)
  let k = 0
  let p = 1
  do {
    k++
    p *= rng.next()
  } while (p > l)
  return k - 1
}

export interface SquareCount {
  /** Cells that exclude the stain (or all cells, unstained). */
  clear: number
  /** Cells that took up a vital stain. */
  blue: number
}

/** Cells per square in a counting chamber, for each square counted. */
export function countSquares(cat: Catalogue, c: Contents, squares: number, squareVolumeL: number, rng: Rng): SquareCount[] {
  const v = liquidVolume(c)
  const mean = meanLayer(c)
  const vital = Object.entries(mean.species).some(([s, n]) => n > 0 && cat.substances.get(s)?.stain?.role === 'vital')
  let live = 0
  let dead = 0
  for (const p of Object.values(mean.populations ?? {})) {
    live += p.viable
    dead += Math.max(0, p.count - p.viable)
  }
  const perL = (n: number) => (v > 0 ? n / v : 0)
  const out: SquareCount[] = []
  for (let i = 0; i < squares; i++) {
    const l = poissonFrom(rng, perL(live) * squareVolumeL)
    const d = poissonFrom(rng, perL(dead) * squareVolumeL)
    out.push(vital ? { clear: l, blue: d } : { clear: l + d, blue: 0 })
  }
  return out
}
