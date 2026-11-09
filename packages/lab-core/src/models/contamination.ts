// Contamination (contract contamination, T1; scientific simulation §3.1): where unwanted
// organisms come from. Airborne cells settle on what is uncovered on the bench (per cm² of opening
// per hour); the rim of a bottle or tube that has been handled lets one in now and then, ten times
// less often once the neck is flamed; fingers carry skin flora that washing reduces. The rates and
// each source's mix of organisms are pack data (a model with contract "contamination"); with none
// declared, nothing contaminates. Only a vessel the learner has explicitly uncovered is exposed:
// a definition that never takes a lid off is taken to be handled aseptically.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { type Container, mergePopulation, type Population, type SurfaceCells, type World } from '../kernel/state.ts'
import { createRng } from '../rng/rng.ts'
import { parseValue } from '../units/index.ts'
import { poisson } from './growth.ts'

type Flora = Array<[organism: string, fraction: number]>

export interface ContaminationParams {
  air: Flora
  rim: Flora
  hands: Flora
  /** Chance that one access to (or re-capping of) an uncovered vessel lets a contaminant in. */
  rimUnflamed: number
  rimFlamed: number
  /** Mean cells let in when it happens. */
  rimCells: number
  /** Mean cells a fingertip press leaves on agar, by how the hands were last cleaned. */
  handCells: { unwashed: number; washed: number; antiseptic: number }
}

const cache = new WeakMap<Catalogue, ContaminationParams | null>()

/** The pack's contamination model, if any (flat keys: air.flora.<organism>, rim.unflamed …). */
export function contaminationParams(cat: Catalogue): ContaminationParams | null {
  if (cache.has(cat)) return cache.get(cat)!
  let out: ContaminationParams | null = null
  for (const m of cat.models.values()) {
    if (m.contract !== 'contamination' || m.kind !== 'process') continue
    const p = m.params ?? {}
    const flora = (source: string): Flora => {
      const xs = Object.entries(p)
        .filter(([k, v]) => k.startsWith(`${source}.flora.`) && typeof v === 'number' && v > 0)
        .map(([k, v]) => [k.slice(source.length + 7), v as number] as [string, number])
      const sum = xs.reduce((a, [, f]) => a + f, 0)
      return xs.map(([o, f]) => [o, f / sum])
    }
    const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d)
    out = {
      air: flora('air'),
      rim: flora('rim'),
      hands: flora('hands'),
      rimUnflamed: num('rim.unflamed', 0.04),
      rimFlamed: num('rim.flamed', 0.001),
      rimCells: num('rim.cells', 3),
      handCells: { unwashed: num('hands.unwashed', 150), washed: num('hands.washed', 25), antiseptic: num('hands.antiseptic', 4) },
    }
    break
  }
  cache.set(cat, out)
  return out
}

/** Split n cells among a flora (each cell drawn independently). */
function draw(flora: Flora, n: number, seed: string): Record<string, number> {
  const rng = createRng(seed)
  const out: Record<string, number> = {}
  for (let i = 0; i < n; i++) {
    let u = rng.next()
    let pick = flora[flora.length - 1][0]
    for (const [o, f] of flora) {
      u -= f
      if (u <= 0) {
        pick = o
        break
      }
    }
    out[pick] = (out[pick] ?? 0) + 1
  }
  return out
}

/** Put cells into a vessel: onto agar they lie scattered on the surface; into liquid, into its top layer. */
export function inoculate(cat: Catalogue, c: Container, cells: Record<string, number>): number {
  let n = 0
  const agar = cat.property(c.equipment, 'agar') === true
  for (const [organism, k] of Object.entries(cells)) {
    if (!(k > 0)) continue
    if (agar) {
      const surface = (c.contents.surface ??= {})
      const s = (surface[organism] ??= { count: 0, viable: 0, doublings: 0, spread: true, discrete: true } as SurfaceCells)
      // Late arrivals join colonies of their own kind that are already growing (a close enough approximation).
      s.count += k
      s.viable += k
      s.spread = true
    } else {
      const top = c.contents.layers[0]
      if (!top || top.volumeL <= 0) continue
      top.populations ??= {}
      mergePopulation((top.populations[organism] ??= { count: 0, viable: 0 } as Population), { count: k, viable: k }, 1)
    }
    n += k
  }
  return n
}

/** Opening area (cm²): a plate's agar, or the mouth of a bottle, tube or flask. */
function openingCm2(cat: Catalogue, c: Container): number {
  const v = cat.property(c.equipment, 'area') ?? cat.property(c.equipment, 'mouthArea')
  return v === undefined ? 0 : parseValue(String(v)).si * 1e4
}

/** Airborne cells settling on an uncovered vessel over dt seconds. */
export function settle(cat: Catalogue, world: World, c: Container, dt: number): void {
  if (!c.uncovered) return
  const params = contaminationParams(cat)
  if (!params || params.air.length === 0) return
  const place = world.places[c.place]
  const rate = Number(place ? (cat.property(place.equipment, 'airborne') ?? 0) : 0)
  if (!(rate > 0)) return
  const area = openingCm2(cat, c)
  if (!(area > 0)) return
  const seed = `${world.seed}|air|${c.id}|${Math.round(world.timeS)}`
  const n = poisson((rate * area * dt) / 3600, seed)
  if (n > 0) inoculate(cat, c, draw(params.air, n, `${seed}|which`))
}

/**
 * One handling of an uncovered vessel's rim (a transfer in or out, or the cap going back on).
 * Returns the cells let in. A vessel without a neck to flame (a plate, a microtube) has no rim risk.
 */
export function rimContact(cat: Catalogue, world: World, c: Container, event: number): number {
  if (!c.uncovered || cat.property(c.equipment, 'flameNeck') !== true) return 0
  const params = contaminationParams(cat)
  if (!params || params.rim.length === 0) return 0
  const flamed = c.neck === 'flamed'
  c.neck = 'handled'
  const seed = `${world.seed}|rim|${c.id}|${event}`
  if (createRng(seed).next() >= (flamed ? params.rimFlamed : params.rimUnflamed)) return 0
  return inoculate(cat, c, draw(params.rim, Math.max(1, poisson(params.rimCells, `${seed}|n`)), `${seed}|which`))
}

/** A fingertip press on agar: the skin flora the hands carry now. */
export function fingerprint(cat: Catalogue, world: World, c: Container, event: number): number {
  const params = contaminationParams(cat)
  if (!params || params.hands.length === 0) return 0
  const seed = `${world.seed}|hands|${c.id}|${event}`
  const n = poisson(params.handCells[world.operator.hands ?? 'unwashed'], seed)
  return inoculate(cat, c, draw(params.hands, n, `${seed}|which`))
}
