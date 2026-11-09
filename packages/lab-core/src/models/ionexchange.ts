// Ion exchange (contract separation.ion-exchange, T2) on a gel-filtration matrix that carries fixed
// charges (CM-Sephadex: carboxymethyl groups, negative above about pH 4). Each solute's band moves
// down the bed at a speed set by the buffer around it:
//  - size exclusion as on any gel (Kav, models/sizeexclusion.ts);
//  - a solute charged opposite to the resin is held, k = ionised share × (I₀/I)^(|z|/2), so it binds
//    at low ionic strength and lets go as the salt rises (stoichiometric displacement);
//  - a solute charged like the resin is pushed out of the beads' pores (Donnan exclusion: it
//    partitions into them as λ^|z|, λ = (√(X² + 4I²) − X) / 2I for fixed charge X).
// Buffer ions are small and travel with the total volume, so a stronger buffer arrives as a front;
// a protein it releases runs ahead into the weaker buffer, is held again, and so leaves with the front.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { parseValue } from '../units/index.ts'
import { fractions } from './acidbase.ts'
import { type ColumnSpec, kav, phi } from './sizeexclusion.ts'

export interface IonExchanger {
  kind: 'cation' | 'anion'
  /** pKa of the resin's groups: they are charged above it (a cation exchanger) or below (an anion exchanger). */
  pKa: number
  /** Ionic strength (mol/L) at which a counter-charged solute is neither held nor not (k = 1). */
  strengthM: number
  /** Fixed charge inside the beads (mol/L), for the Donnan exclusion of like-charged solutes. */
  fixedChargeM: number
}

export function exchangerOf(cat: Catalogue, equipment: string): IonExchanger | undefined {
  const kind = cat.property(equipment, 'ionExchange')
  if (kind !== 'cation' && kind !== 'anion') return undefined
  const q = (k: string, d: string) => parseValue(String(cat.property(equipment, k) ?? d)).si / 1000
  return { kind, pKa: Number(cat.property(equipment, 'exchangePKa') ?? (kind === 'cation' ? 4 : 9.5)), strengthM: q('exchangeStrength', '0.5 M'), fixedChargeM: q('fixedCharge', '0.2 M') }
}

/** Charges a protein carries per pH unit away from its isoelectric point (a rough titration slope). */
const PROTEIN_CHARGE_PER_PH = 1.6

/** A solute's net charge at a pH: its acid–base forms, or a protein's from its pI; 0 for neutral polymers. */
export function soluteCharge(cat: Catalogue, substance: string, pH: number): number {
  const def = cat.substances.get(substance)
  const ab = def?.acidBase
  if (ab) {
    const a = fractions([...ab.pKa].sort((x, y) => x - y), pH)
    return a.reduce((q, f, i) => q + f * ((ab.charge ?? 0) - i), 0)
  }
  const pI = def?.protein?.pI
  return pI === undefined ? 0 : Math.max(-15, Math.min(15, PROTEIN_CHARGE_PER_PH * (pI - pH)))
}

/** What the resin does to a solute of charge z in a buffer of ionic strength I and pH: retention k and pore partition. */
export function retention(ex: IonExchanger, z: number, ionicM: number, pH: number): { k: number; partition: number } {
  const ionised = 1 / (1 + Math.pow(10, ex.kind === 'cation' ? ex.pKa - pH : pH - ex.pKa))
  const I = Math.max(ionicM, 1e-3)
  if (Math.abs(z) < 0.05) return { k: 0, partition: 1 }
  const counter = ex.kind === 'cation' ? z > 0 : z < 0
  if (counter) return { k: ionised * Math.pow(ex.strengthM / I, Math.abs(z) / 2), partition: 1 }
  const X = ex.fixedChargeM * ionised
  const lambda = (Math.sqrt(X * X + 4 * I * I) - X) / (2 * I)
  return { k: 0, partition: Math.pow(lambda, Math.abs(z)) }
}

/** The buffers that have entered the bed: from how much had passed, their ionic strength and pH. */
export interface BufferSegment {
  fromL: number
  ionicM: number
  pH: number
}

/** The buffer at a point of the bed: the one that entered when `enteredL` had passed (before the first, the first). */
function bufferAt(segments: readonly BufferSegment[], enteredL: number): BufferSegment {
  let s = segments[0]
  for (const x of segments) if (x.fromL <= enteredL) s = x
  return s
}

/**
 * Move a solute's band from `fromL` to `toL` of buffer passed; returns its new position (0 top,
 * 1 bottom) and the share of it that left the bed meanwhile.
 */
export function moveBand(cat: Catalogue, col: ColumnSpec, ex: IonExchanger, segments: readonly BufferSegment[], substance: string, molarMassG: number, sampleL: number, x0: number, fromL: number, toL: number): { x: number; share: number } {
  const k0 = kav(col, molarMassG)
  const ve0 = col.voidL + k0 * (col.totalL - col.voidL)
  const sigma = Math.sqrt(1 / col.plates + (sampleL / ve0) ** 2 / 12)
  const steps = Math.max(10, Math.ceil((toL - fromL) / (col.totalL / 300)))
  const dV = (toL - fromL) / steps
  let x = x0
  let V = fromL
  for (let i = 0; i < steps; i++) {
    // The buffer here entered the bed x·Vt ago: buffer ions fill every pore, so they move with the total volume.
    const local = bufferAt(segments, V + dV / 2 - x * col.totalL)
    const r = retention(ex, soluteCharge(cat, substance, local.pH), local.ionicM, local.pH)
    const ve = (col.voidL + k0 * r.partition * (col.totalL - col.voidL)) * (1 + r.k)
    x += dV / ve
    V += dV
  }
  return { x, share: Math.max(0, phi((x - 1) / sigma) - phi((x0 - 1) / sigma)) }
}
