// Western blotting (contracts transfer.blot and binding.affinity, T2). Blotting moves each
// lane's protein bands from an SDS gel onto a membrane at the same positions (large proteins
// transfer less completely). On the membrane, antibodies in the liquid bind the bands that hold
// their target, with on and off rates, and a secondary binds the primary where it sits. The rest
// of the membrane behaves like any high-binding surface (models/binding.ts): blocking protein
// fills it, and without blocking antibodies stick everywhere and the background darkens. A
// chromogenic substrate deposits colour where the enzyme on the bound conjugate is.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents, Species } from '../kernel/state.ts'
import { antibodiesOf, boundKey, matchesTarget } from './binding.ts'
import { type GelMatrix, proteinPieces } from './electrophoresis.ts'
import { parseValue } from '../units/index.ts'

/** Share of a protein chain that leaves the gel for the membrane: lower for big ones. */
export function transferShare(kDa: number): number {
  return Math.max(0.3, Math.min(0.9, 0.9 - 0.25 * Math.log10(Math.max(kDa, 20) / 20)))
}

/** The bands of one gel lane, as they land on the membrane. */
export function bandsFromLane(cat: Catalogue, lane: Contents, gel: GelMatrix, lengthMm: number): Array<{ positionMm: number; species: Species; prestained: boolean }> {
  if (gel.kind !== 'acrylamide') return []
  const out: Array<{ positionMm: number; species: Species; prestained: boolean }> = []
  for (const p of proteinPieces(cat, lane)) {
    const pos = lane.migration?.[p.key]
    if (pos === undefined || pos < 0 || pos > lengthMm || p.ng <= 0) continue
    const substance = p.key.split('#')[0]
    const def = cat.substances.get(substance)
    // Chains as molecules of their own mass (a 35 kDa LDH chain carries LDH's epitopes).
    const mol = (p.ng * 1e-9 * transferShare(p.size)) / (p.size * 1000)
    out.push({ positionMm: pos, species: { [substance]: mol }, prestained: def?.protein?.prestained === true })
  }
  return out
}

/** One step of antibody binding to the bands of a blot. */
export function blotStep(cat: Catalogue, c: Contents, dt: number): void {
  const blot = c.blot
  const layer = c.layers[c.layers.length - 1]
  if (!blot || !layer || !(layer.volumeL > 0)) return
  for (const ab of antibodiesOf(cat)) {
    for (const band of blot.bands) {
      const free = layer.species[ab.id] ?? 0
      const bound = band.bound[boundKey(ab.id)] ?? 0
      if (!(free > 0) && !(bound > 0)) continue
      let sites = 0
      for (const [k, n] of [...Object.entries(band.species), ...Object.entries(band.bound)]) if (matchesTarget(cat, ab.target, k)) sites += n
      let taken = 0
      for (const other of antibodiesOf(cat)) if (other.target === ab.target) taken += band.bound[boundKey(other.id)] ?? 0
      const freeSites = Math.max(0, sites - taken)
      let net = (ab.kon * (free / layer.volumeL) * freeSites - ab.koff * bound) * dt
      net = Math.max(-bound, Math.min(net, free, freeSites))
      if (net === 0) continue
      layer.species[ab.id] = free - net
      band.bound[boundKey(ab.id)] = bound + net
    }
  }
}

/**
 * Develop a blot with a precipitating substrate for `seconds`: each band darkens with the enzyme
 * bound there (on the conjugate), and the whole membrane with the enzyme stuck to it elsewhere.
 * Returns the colour deposited per band (mol of product) and the background per cm².
 */
export function developBlot(cat: Catalogue, c: Contents, seconds: number, areaCm2: number): { signals: number[]; backgroundPerCm2: number } {
  const blot = c.blot
  if (!blot) return { signals: [], backgroundPerCm2: 0 }
  const rate = (id: string) => {
    const e = cat.substances.get(id.replace(/@bound$/, ''))?.enzyme
    return e ? parseValue(e.kcat).si : 0
  }
  const turnover = (sp: Species) => Object.entries(sp).reduce((a, [id, n]) => a + n * rate(id), 0)
  const signals = blot.bands.map((b) => {
    b.signal = (b.signal ?? 0) + turnover(b.bound) * seconds
    return b.signal
  })
  blot.background = (blot.background ?? 0) + (turnover(c.adsorbed ?? {}) * seconds) / areaCm2
  return { signals, backgroundPerCm2: blot.background }
}
