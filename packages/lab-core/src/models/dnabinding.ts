// Protein–DNA binding in solution (contract binding.affinity, T2): what a gel shift shows. A
// DNA-binding protein declares the DNAs that carry its site and a dissociation constant; an
// inducer that binds the protein (IPTG on LacI) weakens it, Kd × (1 + (f − 1) θ) with θ the
// inducer's occupancy. Every DNA with the site competes for the same free protein, so excess
// unlabelled site DNA takes protein away from a labelled probe. Equilibrium is reached at once.
// A non-specific binder coats any DNA (with free ends, if it needs them to load), one independent
// site per footprint: a DNA with n sites at occupancy θ is free with probability (1 − θ)ⁿ, and
// otherwise carries on average nθ / (1 − (1 − θ)ⁿ) proteins, so the shift grows with the protein.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'

export interface Complexes {
  /** Share of each DNA bound, and the binding protein's mass (Da) that rides with it. */
  bound: Record<string, { fraction: number; proteinDa: number; protein: string }>
}

/** A DNA a non-specific binder can coat: a molecule of known length (not a ladder), and not a closed circle if it needs ends. */
function coatable(cat: Catalogue, s: string, needsEnds: boolean): boolean {
  const dna = cat.substances.get(s)?.dna
  if (!dna?.lengthBp || dna.fragments?.length) return false
  return !(needsEnds && dna.topology === 'circular')
}

export function dnaComplexes(cat: Catalogue, c: Contents): Complexes {
  const out: Complexes = { bound: {} }
  const v = c.layers.reduce((a, l) => a + l.volumeL, 0)
  if (!(v > 0)) return out
  const mol: Record<string, number> = {}
  for (const l of c.layers) for (const [s, n] of Object.entries(l.species)) if (n > 0) mol[s] = (mol[s] ?? 0) + n
  for (const [p, nP] of Object.entries(mol)) {
    const def = cat.substances.get(p)
    const binding = def?.dnaBinding
    if (!binding) continue
    let kd = parseValue(binding.kd).si / 1000
    if (binding.inducer) {
      const i = (mol[binding.inducer.substance] ?? 0) / v
      const ki = parseValue(binding.inducer.kd).si / 1000
      const theta = i / (i + ki)
      kd *= 1 + (binding.inducer.factor - 1) * theta
    }
    const named = binding.nonspecific ? Object.keys(mol).filter((t) => coatable(cat, t, binding.requiresEnds === true)) : (binding.targets ?? [])
    const targets = named.filter((t) => (mol[t] ?? 0) > 0).map((t) => {
      const bp = cat.substances.get(t)?.dna?.lengthBp ?? 0
      return { t, d: mol[t] / v, n: binding.footprintBp ? Math.max(1, Math.floor(bp / binding.footprintBp)) : 1 }
    })
    if (!targets.length) continue
    const pTot = nP / v
    // Free protein: pTot = P + Σ nᵢ Dᵢ P / (Kd + P), solved by bisection.
    let lo = 0
    let hi = pTot
    for (let k = 0; k < 80; k++) {
      const mid = (lo + hi) / 2
      const used = mid + targets.reduce((a, x) => a + (x.n * x.d * mid) / (kd + mid), 0)
      if (used > pTot) hi = mid
      else lo = mid
    }
    const pFree = (lo + hi) / 2
    const theta = pFree / (kd + pFree)
    const da = def?.physical?.molarMass ? parseValue(def.physical.molarMass).si * 1000 : 50000
    for (const x of targets) {
      const fraction = x.n === 1 ? theta : 1 - Math.pow(1 - theta, x.n)
      out.bound[x.t] = { fraction, proteinDa: fraction > 0 ? (da * x.n * theta) / fraction : da, protein: p }
    }
  }
  return out
}
