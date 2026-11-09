// Gel electrophoresis (contract separation.by-size, T1). In agarose, DNA moves towards the anode
// at a speed that falls with the log of its length, within a range set by the agarose percentage.
// In an SDS-polyacrylamide gel, proteins coated in SDS run by the log of their chains' mass, so a
// protein of several subunits gives a band for each kind of chain; without SDS they do not
// resolve. Bands that run past the end of the gel are lost, and a reversed field runs the sample
// out of the wells. A stain makes bands visible above its detection limit. The learner sees
// positions in mm and judges sizes against a ladder: the gel never labels a band with its size.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents } from '../kernel/state.ts'
import { digestPieces } from './digestion.ts'
import { dnaComplexes } from './dnabinding.ts'
import { parseValue } from '../units/index.ts'

/** Front speed (mm/min) at 100 V: in a 1 % agarose gel, and in a polyacrylamide gel. */
const FRONT_MM_PER_MIN = 1.6
const PROTEIN_FRONT_MM_PER_MIN = 0.75
/** Bands closer than this (mm) are not resolved. */
const RESOLUTION_MM = 1.2
/** Detectable and saturating amounts in a band (ng), unless the gel declares its stain's. */
const DETECT_NG = 2
const SATURATE_NG = 150
/** SDS (g/L) a sample needs for its proteins to run by chain mass. */
const SDS_NEEDED_G_PER_L = 1

export interface GelMatrix {
  /** Agarose (DNA), SDS-polyacrylamide (proteins by chain mass), or native polyacrylamide (DNA and its complexes). */
  kind: 'agarose' | 'acrylamide' | 'native'
  pct: number
  detectNg: number
  saturateNg: number
}

/** The gel's matrix and stain, from its equipment properties. */
export function gelMatrix(cat: Catalogue, equipment: string): GelMatrix {
  const acrylamide = cat.property(equipment, 'acrylamide')
  const detectNg = Number(cat.property(equipment, 'detectNg') ?? DETECT_NG)
  const saturateNg = Number(cat.property(equipment, 'saturateNg') ?? SATURATE_NG)
  // A native gel runs DNA as agarose of about half its percentage would (a 6 % gel resolves 20–800 bp).
  if (acrylamide !== undefined && cat.property(equipment, 'native') === true) return { kind: 'native', pct: Number(acrylamide) * 0.55, detectNg, saturateNg }
  if (acrylamide !== undefined) return { kind: 'acrylamide', pct: Number(acrylamide), detectNg, saturateNg }
  return { kind: 'agarose', pct: Number(cat.property(equipment, 'agarose') ?? 1), detectNg, saturateNg }
}

/** Relative mobility (0..1) of a fragment in a gel of a given agarose percentage. */
export function mobility(bp: number, agarosePct: number): number {
  // Higher percentages move the resolving range to smaller fragments.
  const logTop = Math.log10(20000) - 0.6 * (agarosePct - 1)
  const logFront = Math.log10(50) - 0.3 * (agarosePct - 1)
  const m = (logTop - Math.log10(bp)) / (logTop - logFront)
  return Math.max(0.02, Math.min(1, m))
}

/** Relative mobility (0..1) of an SDS-coated chain (kDa) in a gel of a given acrylamide percentage. */
export function proteinMobility(kDa: number, acrylamidePct: number): number {
  // A 12 % gel resolves about 10 to 200 kDa; denser gels shift the range to smaller chains.
  const scale = Math.pow(12 / acrylamidePct, 1.5)
  const logTop = Math.log10(300 * scale)
  const logFront = Math.log10(8 * scale)
  const m = (logTop - Math.log10(kDa)) / (logTop - logFront)
  return Math.max(0.02, Math.min(1, m))
}

export interface Piece {
  key: string
  /** Length (bp) in agarose, chain mass (kDa) in polyacrylamide; what it runs alongside. */
  size: number
  ng: number
}

/** DNA pieces in a lane's contents: molecules with a length, each ladder fragment separately. */
export function dnaPieces(cat: Catalogue, c: Contents): Piece[] {
  const out: Piece[] = []
  const complexes = dnaComplexes(cat, c)
  for (const [s, n] of Object.entries(totals(c))) {
    const def = cat.substances.get(s)
    const dna = def?.dna
    if (dna?.fragments?.length) {
      // A ladder: mass shared between its fragments.
      const g = n * (def?.physical?.molarMass ? parseValue(def.physical.molarMass).si * 1000 : 1)
      for (const f of dna.fragments) out.push({ key: `${s}#${f.bp}`, size: f.bp, ng: g * f.fraction * 1e9 })
    } else if (dna?.lengthBp && (dna.sites || dna.topology === 'circular')) {
      // Cut or circular DNA: its fragments and forms, each running at its apparent length; a bound
      // share of each runs larger by the protein riding on it.
      const b = complexes.bound[s]
      const f = b?.fraction ?? 0
      for (const p of digestPieces(cat, c, s)) {
        if (f < 1) out.push({ key: p.key, size: p.apparentBp, ng: p.ng * (1 - f) })
        if (b && f > 0) out.push({ key: `${p.key}+${b.protein}`, size: p.apparentBp * (1 + b.proteinDa / (dna.lengthBp * 650)), ng: p.ng * f })
      }
    } else if (dna?.lengthBp) {
      // A bound share runs as a complex, larger by the protein riding on it (a gel shift).
      const ng = n * dna.lengthBp * 650 * 1e9
      const b = complexes.bound[s]
      const f = b?.fraction ?? 0
      if (f < 1) out.push({ key: s, size: dna.lengthBp, ng: ng * (1 - f) })
      if (b && f > 0) out.push({ key: `${s}+${b.protein}`, size: dna.lengthBp * (1 + b.proteinDa / (dna.lengthBp * 650)), ng: ng * f })
    } else if (def?.tracking) {
      out.push({ key: s, size: def.tracking.apparentBp, ng: 0 })
    }
  }
  return out
}

/**
 * Protein pieces in a lane: with enough SDS, each kind of chain of each protein (a protein with no
 * declared subunits is one chain), and every band of a protein ladder. Tracking dye runs with the
 * front. Proteins without SDS keep their native shape and charge and do not resolve.
 */
export function proteinPieces(cat: Catalogue, c: Contents): Piece[] {
  const out: Piece[] = []
  const mol = totals(c)
  const volumeL = c.layers.reduce((a, l) => a + l.volumeL, 0)
  let sdsGPerL = 0
  for (const [s, n] of Object.entries(mol)) {
    const def = cat.substances.get(s)
    if (def?.detergent?.denaturing && def.physical?.molarMass && volumeL > 0) sdsGPerL += (n * parseValue(def.physical.molarMass).si * 1000) / volumeL
  }
  for (const [s, n] of Object.entries(mol)) {
    const def = cat.substances.get(s)
    const grams = n * (def?.physical?.molarMass ? parseValue(def.physical.molarMass).si * 1000 : 0)
    if (def?.protein?.ladder?.length) {
      for (const f of def.protein.ladder) out.push({ key: `${s}#${f.kDa}`, size: f.kDa, ng: grams * f.fraction * 1e9 })
    } else if (def?.tracking) {
      out.push({ key: s, size: 1, ng: 0 })
    } else if (def?.protein && sdsGPerL >= SDS_NEEDED_G_PER_L && grams > 0) {
      const chains = def.protein.subunits?.length ? def.protein.subunits : [{ kDa: grams / n / 1000, count: 1 }]
      for (const ch of chains) out.push({ key: `${s}#${ch.kDa}`, size: ch.kDa, ng: n * ch.count * ch.kDa * 1000 * 1e9 })
    }
  }
  return out
}

function totals(c: Contents): Record<string, number> {
  const mol: Record<string, number> = {}
  for (const l of c.layers) for (const [s, n] of Object.entries(l.species)) if (n > 0) mol[s] = (mol[s] ?? 0) + n
  return mol
}

export function lanePieces(cat: Catalogue, c: Contents, gel: GelMatrix): Piece[] {
  return gel.kind === 'acrylamide' ? proteinPieces(cat, c) : dnaPieces(cat, c)
}

/**
 * Run the gel: each piece moves on by speed × time × its mobility. In agarose the percentage acts
 * through the mobility (denser gels move the resolving range to smaller DNA), and a tracking dye, a
 * small molecule, runs as it would in 1 % agarose whatever the gel: bromophenol blue keeps pace with
 * about 400 bp in a 1 % gel and about 150 bp in a 2 % one, at much the same distance. A native gel
 * also runs more slowly the denser it is.
 */
export function runLane(cat: Catalogue, c: Contents, gel: GelMatrix, volts: number, minutes: number): void {
  c.migration ??= {}
  const protein = gel.kind === 'acrylamide'
  const speed = protein ? PROTEIN_FRONT_MM_PER_MIN * (volts / 100) : FRONT_MM_PER_MIN * (volts / 100) / (gel.kind === 'native' ? gel.pct : 1)
  for (const p of lanePieces(cat, c, gel)) {
    const dye = p.ng === 0 && gel.kind === 'agarose'
    const m = protein ? proteinMobility(p.size, gel.pct) : mobility(p.size, dye ? 1 : gel.pct)
    c.migration[p.key] = (c.migration[p.key] ?? 0) + speed * minutes * m
  }
}

export interface Band {
  positionMm: number
  ng: number
  intensity: 'faint' | 'clear' | 'bright' | 'saturated'
}

/** What a stained lane shows: bands in the gel, merged when too close to resolve. */
export function laneBands(cat: Catalogue, c: Contents, lengthMm: number, gel: GelMatrix, only?: (key: string) => boolean): { bands: Band[]; dyeFrontMm?: number } {
  const pieces = lanePieces(cat, c, gel).filter((p) => p.ng === 0 || !only || only(p.key))
  let dyeFrontMm: number | undefined
  const placed: Array<{ pos: number; ng: number }> = []
  for (const p of pieces) {
    const pos = c.migration?.[p.key]
    if (pos === undefined || pos < 0 || pos > lengthMm) continue
    if (p.ng === 0) {
      dyeFrontMm = pos
      continue
    }
    placed.push({ pos, ng: p.ng })
  }
  placed.sort((a, b) => a.pos - b.pos)
  const merged: Array<{ pos: number; ng: number }> = []
  for (const p of placed) {
    const last = merged[merged.length - 1]
    if (last && p.pos - last.pos < RESOLUTION_MM) {
      last.pos = (last.pos * last.ng + p.pos * p.ng) / (last.ng + p.ng)
      last.ng += p.ng
    } else merged.push({ ...p })
  }
  const bands = merged
    .filter((b) => b.ng >= gel.detectNg)
    .map((b) => ({
      positionMm: b.pos,
      ng: b.ng,
      intensity: (b.ng >= gel.saturateNg ? 'saturated' : b.ng >= 25 * gel.detectNg ? 'bright' : b.ng >= 5 * gel.detectNg ? 'clear' : 'faint') as Band['intensity'],
    }))
  return { bands, ...(dyeFrontMm !== undefined ? { dyeFrontMm } : {}) }
}
