// Size-exclusion chromatography (contract separation.size-exclusion, T2). A solute's elution
// volume is Ve = V0 + Kav (Vt − V0), where Kav falls linearly with the log of its native molar
// mass across the matrix's fractionation range: larger than the range, it is excluded and leaves
// with the void volume; smaller, it enters every pore and leaves with the total volume. Each
// solute leaves as a Gaussian band of σ² = (Ve/√N)² + Vs²/12 (N theoretical plates, Vs the
// sample's own volume), so a large sample volume blurs neighbouring peaks together.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { parseValue } from '../units/index.ts'

export interface ColumnSpec {
  /** Total bed volume and void volume (L). */
  totalL: number
  voidL: number
  /** Fractionation range (g/mol): fully excluded above, fully included below. */
  excludedAbove: number
  includedBelow: number
  plates: number
}

export function columnSpec(cat: Catalogue, equipment: string): ColumnSpec {
  const q = (k: string, d: string) => parseValue(String(cat.property(equipment, k) ?? d)).si
  return {
    totalL: q('bedVolume', '24 mL') * 1000,
    voidL: q('voidVolume', '8 mL') * 1000,
    excludedAbove: Number(cat.property(equipment, 'excludedAbove') ?? 250000),
    includedBelow: Number(cat.property(equipment, 'includedBelow') ?? 5000),
    plates: Number(cat.property(equipment, 'plates') ?? 400),
  }
}

/** Kav (0..1) of a solute of native molar mass M (g/mol). */
export function kav(col: ColumnSpec, molarMassGPerMol: number): number {
  const hi = Math.log10(col.excludedAbove)
  const lo = Math.log10(col.includedBelow)
  return Math.max(0, Math.min(1, (hi - Math.log10(molarMassGPerMol)) / (hi - lo)))
}

/** Elution volume (L) of a solute. */
export function elutionVolume(col: ColumnSpec, molarMassGPerMol: number): number {
  return col.voidL + kav(col, molarMassGPerMol) * (col.totalL - col.voidL)
}

/** The share of a solute's band that leaves between volumes a and b (L) of buffer passed. */
export function bandShare(col: ColumnSpec, molarMassGPerMol: number, sampleL: number, a: number, b: number): number {
  const ve = elutionVolume(col, molarMassGPerMol)
  const sigma = Math.sqrt((ve / Math.sqrt(col.plates)) ** 2 + (sampleL * sampleL) / 12)
  return Math.max(0, phi((b - ve) / sigma) - phi((a - ve) / sigma))
}

/** The standard normal cumulative distribution (Abramowitz and Stegun 7.1.26, error < 1.5e-7). */
export function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}
