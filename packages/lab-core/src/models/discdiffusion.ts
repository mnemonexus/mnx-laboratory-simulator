// Disc diffusion (contract antimicrobial.disc-diffusion, T2; Cooper's model). An antibiotic disc on
// a freshly seeded plate releases its drug into the agar, which spreads as from a point source in a
// slab: C(r, t) = M / (4π D t h) · exp(−r² / 4Dt). Meanwhile the lawn grows. Where the lawn reaches
// its critical density (models/growth.ts) before the drug reaches the organism's MIC, it grows; the
// zone's edge is where the two arrive together: r² = 4 D T₀ ln(M / (4π D T₀ h · MIC)), with T₀ the
// time from the disc going on to the lawn reaching critical density. So zones shrink with a heavier
// inoculum, a deeper agar or a disc put on late, and grow with a slower-growing lawn.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Container } from '../kernel/state.ts'
import { liquidVolume } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'
import { combinedRatio, micMolPerL, plateAreaCm2, VISIBLE_DOUBLINGS } from './growth.ts'

/** A standard disc is 6 mm across: no zone reads as 6 mm. */
export const DISC_MM = 6
/** Diffusion of a small antibiotic in agar when the catalogue gives none (cm²/s). */
const DEFAULT_D_CM2_PER_S = 5e-6
/** A strain under this share of the plate's cells forms colonies inside zones, not the lawn's edge. */
const MINORITY = 0.1
/**
 * Cooper's critical concentration as a share of the broth MIC. Agar MICs run below broth ones, and
 * a lawn slowed by sub-MIC drug misses its critical time, so the edge forms below the MIC. Half
 * the MIC puts control strains in their published quality-control ranges.
 */
const CRITICAL_PER_MIC = 0.5
/** Colonies on a plate beyond which they merge into a confluent lawn with a readable edge. */
export const CONFLUENT_COLONIES = 5000

export interface Zone {
  /** The disc (a container) and its position on the plate. */
  disc: string
  position: number
  substance: string
  diameterMm: number
  /** A minority strain grows inside the zone (a mixed culture or resistant mutants). */
  coloniesInside: boolean
}

function diffusionCm2(cat: Catalogue, substance: string): number {
  const d = cat.substances.get(substance)?.antibiotic?.diffusion
  return d ? parseValue(d).si * 1e4 : DEFAULT_D_CM2_PER_S
}

/** Zone diameter (mm) one strain leaves round one disc, or the disc's own size. */
function strainZoneMm(cat: Catalogue, plate: Container, key: string, criticalS: number, disc: { substance: string; mol: number; placedS: number; drugs?: Array<{ substance: string; mol: number }> }): number {
  if (disc.drugs && disc.drugs.length > 1) return comboZoneMm(cat, plate, key, criticalS - disc.placedS, disc.drugs)
  const t0 = criticalS - disc.placedS
  const mic = disc.substance ? micMolPerL(cat, key, disc.substance) : undefined
  if (!(t0 > 0) || mic === undefined) return DISC_MM
  const D = diffusionCm2(cat, disc.substance)
  const area = plateAreaCm2(cat, plate)
  const depthCm = (liquidVolume(plate.contents) * 1000) / area
  // Moles and mol/L throughout: M (mol) over the volume the drug has spread into (mL → L) at the MIC.
  const spreadL = (4 * Math.PI * D * t0 * depthCm) / 1000
  const ratio = disc.mol / (spreadL * mic * CRITICAL_PER_MIC)
  if (ratio <= 1) return DISC_MM
  const r = Math.sqrt(4 * D * t0 * Math.log(ratio))
  return Math.max(DISC_MM, 20 * r)
}

/**
 * A disc carrying several drugs: each spreads by its own diffusion, and the edge is where, taken
 * together (models/growth.ts combinedRatio), they reach the critical concentration.
 */
function comboZoneMm(cat: Catalogue, plate: Container, key: string, t0: number, drugs: Array<{ substance: string; mol: number }>): number {
  if (!(t0 > 0)) return DISC_MM
  const depthCm = (liquidVolume(plate.contents) * 1000) / plateAreaCm2(cat, plate)
  const terms = drugs.flatMap((x) => {
    const mic = micMolPerL(cat, key, x.substance)
    if (mic === undefined) return []
    const D = diffusionCm2(cat, x.substance)
    return [{ substance: x.substance, D, peak: x.mol / (((4 * Math.PI * D * t0 * depthCm) / 1000) * mic * CRITICAL_PER_MIC) }]
  })
  const at = (r: number) => combinedRatio(cat, terms.map((x) => ({ substance: x.substance, ratio: x.peak * Math.exp((-r * r) / (4 * x.D * t0)) })))
  if (terms.length === 0 || at(0) <= 1) return DISC_MM
  // Outward from the disc in 0.05 mm steps to the last radius still inhibited, then bisect.
  let lo = 0
  while (lo < 4.5 && at(lo + 0.005) > 1) lo += 0.005
  let hi = lo + 0.005
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (at(mid) > 1) lo = mid
    else hi = mid
  }
  return Math.max(DISC_MM, 20 * lo)
}

/**
 * The zones round each disc on a plate. Undefined when there is no confluent lawn to read them
 * against (nothing grown yet, or too few cells for a lawn).
 */
export function zonesOn(cat: Catalogue, plate: Container): Zone[] | undefined {
  const discs = plate.contents.discs ?? []
  const surface = plate.contents.surface ?? {}
  const strains = Object.entries(surface).filter(([, s]) => s.viable > 0 && s.doublings >= VISIBLE_DOUBLINGS)
  const total = strains.reduce((a, [, s]) => a + s.viable, 0)
  const lawn = strains.filter(([, s]) => s.viable / total >= MINORITY && s.criticalS !== undefined)
  // Separate colonies are no lawn: their zones have no edge to read against.
  const colonies = strains.reduce((a, [, s]) => a + (s.founders ?? 0), 0)
  if (discs.length === 0 || lawn.length === 0 || colonies < CONFLUENT_COLONIES) return undefined
  // The lawn's critical time sets every edge; a minority strain's cells sit in that lawn.
  const criticalS = Math.min(...lawn.map(([, s]) => s.criticalS!))
  return discs.map((d) => {
    let edge = Infinity
    let inside = Infinity
    for (const [key, s] of strains) {
      const mm = strainZoneMm(cat, plate, key, criticalS, d)
      if (s.viable / total >= MINORITY) edge = Math.min(edge, mm)
      else if ((s.founders ?? 0) >= 1) inside = Math.min(inside, mm)
    }
    return { disc: d.container, position: d.position, substance: d.drugs ? d.drugs.map((x) => x.substance).join('+') : d.substance, diameterMm: edge, coloniesInside: inside < edge - 1 }
  })
}
